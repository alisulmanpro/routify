from __future__ import annotations

import asyncio

from ..db import db, transaction
from ..http import js_round, round2
from . import storage_service as storage
from .delivery_service import archive_deleted
from .route_service import OPEN, summarize_counts

# The map needs five columns of the located stops only, not whole rows. Same filter as the counts in dashboard().
_MAP_SQL = """
SELECT "id", "addressLatitude" AS "latitude", "addressLongitude" AS "longitude", "status"::text AS "status", "stopOrder" AS "order"
FROM "deliveries"
WHERE "riderId" = $1 AND "addressGeocoded" AND ("serviceDate" = $2 OR ("status" IN ('pending', 'in_progress') AND "serviceDate" <= $2))
"""


async def dashboard(actor: dict, date: str) -> dict:
    # Today's work plus anything still open from earlier days; stops planned for later days are not counted yet.
    user, counts, located, active, planned = await asyncio.gather(
        db.user.find_unique(where={"id": actor["id"]}),
        db.delivery.group_by(by=["status"], where={"riderId": actor["id"], "OR": [{"serviceDate": date}, {"status": {"in": list(OPEN)}, "serviceDate": {"lte": date}}]},
                             count=True),
        db.query_raw(_MAP_SQL, actor["id"], date),
        db.route.find_first(where={"riderId": actor["id"], "status": "active"}, order=[{"createdAt": "desc"}, {"id": "desc"}]),
        db.route.find_first(where={"riderId": actor["id"], "status": "planned", "serviceDate": {"lte": date}}, order=[{"createdAt": "desc"}, {"id": "desc"}]),
    )
    route = active or planned
    s = summarize_counts({str(row["status"]): row["_count"]["_all"] for row in counts}, route if route and route.status == "active" else None)
    finished = s["delivered"] + s["failed"]

    next_action = "setup"
    if route and route.status == "active":
        next_action = "continue"
    elif s["pending"] > 0:
        next_action = "start"
    elif s["total"] > 0:
        next_action = "complete"

    return {
        "rider": {"id": actor["id"], "fullName": user.fullName},
        "date": date, **s,
        "progressPercent": js_round(finished / s["total"] * 100) if s["total"] else 0,
        "routeId": route.id if route else None,
        "routeStatus": str(route.status) if route else None,
        "nextAction": next_action,
        "map": [{"id": m["id"], "latitude": m["latitude"], "longitude": m["longitude"], "status": m["status"], "order": m["order"]} for m in located],
    }


async def history(actor: dict, limit: int = 60) -> list[dict]:
    """One row per service date with totals + report/route info."""
    rows, reports, routes = await asyncio.gather(
        db.delivery.group_by(by=["serviceDate", "status"], where={"riderId": actor["id"]}, count=True),
        db.report.find_many(where={"riderId": actor["id"]}),
        db.route.find_many(where={"riderId": actor["id"], "status": "completed"}),
    )
    days: dict[str, dict] = {}
    for row in rows:
        date, status, count = row["serviceDate"], str(row["status"]), row["_count"]["_all"]
        day = days.setdefault(date, {"date": date, "total": 0, "delivered": 0, "failed": 0, "pending": 0, "distanceKm": 0})
        day["total"] += count
        if status == "delivered":
            day["delivered"] += count
        elif status == "failed":
            day["failed"] += count
        else:
            day["pending"] += count
    for r in routes:
        if r.serviceDate in days:
            days[r.serviceDate]["distanceKm"] = round2(days[r.serviceDate]["distanceKm"] + (r.distanceKm or 0))
    with_report = {r.date for r in reports}
    ordered = sorted(days.values(), key=lambda d: d["date"], reverse=True)[:limit]
    return [{**d, "hasReport": d["date"] in with_report} for d in ordered]


async def clear_history(actor: dict) -> dict:
    """Permanently removes completed rider work and its downloadable reports."""
    finished = {"riderId": actor["id"], "status": {"in": ["delivered", "failed"]}}
    reports, done = await asyncio.gather(
        db.report.find_many(where={"riderId": actor["id"]}),
        db.delivery.find_many(where=finished),
    )
    photos = [d for d in done if d.proofPhotoKey]
    # The finished stops are kept in deleted_deliveries (P4.6); their photo files go, as before.
    async with transaction() as tx:
        await archive_deleted(tx, done, "clear_history")
        deliveries = await tx.delivery.delete_many(where={"id": {"in": [d.id for d in done]}}) if done else 0
        routes = await tx.route.delete_many(where={"riderId": actor["id"], "status": "completed"})
    await db.report.delete_many(where={"riderId": actor["id"]})
    # Customer doorstep photos go with the deliveries they prove.
    await asyncio.gather(*(storage.remove(r.fileKey) for r in reports), *(storage.remove(d.proofPhotoKey) for d in photos))
    return {"deliveriesDeleted": deliveries, "routesDeleted": routes, "reportsDeleted": len(reports)}
