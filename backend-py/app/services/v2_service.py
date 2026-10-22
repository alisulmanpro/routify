"""The lean /api/v2 rider API: only the fields the rider app renders, counted in SQL, one request per screen or action.

Stop fields (what the route map, stop cards, route details and route-complete screens read):
id, order, status, trackingId, customerName, address{raw, normalized, latitude, longitude, geocoded, approximate,
geocodeStatus, postalCode}, legDistanceKm, legDurationMin, failureReason, deliveredAt, failedAt.
Phone, notes, proof photos and timestamps stay on GET /api/v1/deliveries/{id} (the stop details screen).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from ..db import db, lock_rider, transaction
from ..errors import conflict, forbidden, not_found, validation_error
from ..http import iso, js_round, now
from ..uploads import UploadedFile
from . import delivery_service as deliveries
from .route_service import OPEN, _left_over_where, _stop_counts, summarize_counts
from .serializers import clean_delivery_address
from .subscription_service import assert_can_create_deliveries, effective_status

# Changes are compared with a few seconds of slack: rows are stamped by the app's clock (Prisma) or the database's.
CHANGES_SLACK = timedelta(seconds=5)


def _require_rider(actor: dict) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders can do this")


def _ts(value: Any) -> str | None:
    """Raw-SQL timestamps come back as text or datetimes; both are sent in the API's one format (…T09:15:00.000Z)."""
    if value is None or isinstance(value, datetime):
        return iso(value)
    return iso(datetime.fromisoformat(str(value)))


def light_stop(row: dict) -> dict:
    """A stop from a raw-SQL row (_STOP_COLUMNS)."""
    payment = row.get("payment")
    if isinstance(payment, str):
        payment = json.loads(payment)
    return {
        "id": row["id"], "order": row["order"], "status": row["status"], "trackingId": row["trackingId"] or "",
        "customerName": row["customerName"] or "",
        "address": {
            "raw": clean_delivery_address(row["addressRaw"], payment), "normalized": row["addressNormalized"],
            "latitude": row["addressLatitude"], "longitude": row["addressLongitude"], "geocoded": bool(row["addressGeocoded"]),
            "approximate": bool(row["addressApproximate"]), "geocodeStatus": row["geocodeStatus"] or "pending", "postalCode": row["postalCode"] or None,
        },
        "legDistanceKm": row.get("legDistanceKm") or 0, "legDurationMin": row.get("legDurationMin") or 0,
        "failureReason": row["failureReason"], "deliveredAt": _ts(row["deliveredAt"]), "failedAt": _ts(row["failedAt"]),
    }


def light_stop_of(d: Any, *, order: int | None = None) -> dict:
    """The same stop from a Prisma Delivery."""
    return light_stop({
        "id": d.id, "order": order if order is not None else d.stopOrder, "status": str(d.status), "trackingId": d.trackingId,
        "customerName": d.customerName, "addressRaw": d.addressRaw, "addressNormalized": d.addressNormalized, "payment": d.payment,
        "addressLatitude": d.addressLatitude, "addressLongitude": d.addressLongitude, "addressGeocoded": d.addressGeocoded,
        "addressApproximate": d.addressApproximate, "geocodeStatus": str(d.geocodeStatus) if d.geocodeStatus else None, "postalCode": d.postalCode,
        "failureReason": str(d.failureReason) if d.failureReason else None, "deliveredAt": d.deliveredAt, "failedAt": d.failedAt,
    })


# Every stop still on the route, numbered 1..n in route order (as v1 numbers them), optionally only those changed since $2.
_STOPS_SQL = """
SELECT * FROM (
  SELECT d."id", (row_number() OVER (ORDER BY s."order", d."id"))::int AS "order", d."status"::text AS "status", d."trackingId",
         d."customerName", d."addressRaw", d."addressNormalized", d."addressLatitude", d."addressLongitude", d."addressGeocoded",
         d."addressApproximate", d."geocodeStatus"::text AS "geocodeStatus", d."postalCode", d."payment", s."legDistanceKm",
         s."legDurationMin", d."failureReason"::text AS "failureReason", d."deliveredAt", d."failedAt", d."updatedAt"
  FROM "route_stops" AS s JOIN "deliveries" AS d ON d."id" = s."deliveryId" AND d."routeId" = s."routeId"
  WHERE s."routeId" = $1
) AS stops
WHERE $2::timestamp IS NULL OR stops."updatedAt" > $2::timestamp
ORDER BY "order"
"""

# Everything that changes when anything shown on the route changes: the route row (legs, distance, status, order runs
# update it), its stops' rows (status, address, order) and how many stops it has.
_VERSION_SQL = """
SELECT r."updatedAt"::text AS "route", coalesce(max(d."updatedAt")::text, '') AS "stops", count(d."id")::int AS "n",
       coalesce(sum(d."version"), 0)::bigint::text AS "versions"
FROM "routes" AS r LEFT JOIN "deliveries" AS d ON d."routeId" = r."id"
WHERE r."id" = $1 AND r."riderId" = $2
GROUP BY r."id"
"""


async def route_etag(actor: dict, route_id: str) -> str:
    _require_rider(actor)
    rows = await db.query_raw(_VERSION_SQL, route_id, actor["id"])
    if not rows:
        raise not_found("Route")
    row = rows[0]
    digest = hashlib.sha1(f"v1|{row['route']}|{row['stops']}|{row['n']}|{row['versions']}".encode()).hexdigest()[:24]
    return f'W/"{digest}"'


def _header(route: Any, counts: dict[str, int], next_stop_id: str | None) -> dict:
    summary = summarize_counts(counts, route)
    done = summary["total"] - summary["pending"]
    return {
        "id": route.id, "name": route.name or None, "status": str(route.status), "serviceDate": route.serviceDate,
        "preference": str(route.preference), "optimization": route.optimization,
        "origin": {"latitude": route.originLatitude, "longitude": route.originLongitude} if route.originLatitude is not None else None,
        "distanceKm": route.distanceKm, "durationMin": route.durationMin,
        "progress": {"total": summary["total"], "done": done, "remaining": summary["total"] - done},
        "summary": summary, "nextStopId": next_stop_id,
    }


async def _mine(actor: dict, route_id: str) -> Any:
    route = await db.route.find_first(where={"id": route_id, "riderId": actor["id"]})
    if not route:
        raise not_found("Route")
    return route


async def get_route(actor: dict, route_id: str) -> dict:
    """The route with every stop, light."""
    _require_rider(actor)
    route, rows = await asyncio.gather(_mine(actor, route_id), db.query_raw(_STOPS_SQL, route_id, None))
    stops = [light_stop(r) for r in rows]
    counts: dict[str, int] = {}
    for s in stops:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    next_stop = next((s["id"] for s in stops if s["status"] in OPEN), None)
    return {**_header(route, counts, next_stop), "stops": stops}


def parse_cursor(value: str) -> datetime:
    try:
        at = datetime.fromisoformat(value)
    except ValueError:
        raise validation_error([{"path": "since", "message": "Must be a cursor returned by this API"}]) from None
    return at if at.tzinfo else at.replace(tzinfo=UTC)


async def route_changes(actor: dict, route_id: str, since: datetime) -> dict:
    """What changed on the route since `since` (a previous `cursor`). The client applies `stops` by id, drops `removed`, and
    reloads the full route when its stop count then differs from `stopCount` (a deleted stop leaves no trace to report)."""
    _require_rider(actor)
    cursor = now()
    after = (since - CHANGES_SLACK).astimezone(UTC).replace(tzinfo=None).isoformat()
    route, changed, removed, counts, next_rows = await asyncio.gather(
        _mine(actor, route_id),
        db.query_raw(_STOPS_SQL, route_id, after),
        db.query_raw("""SELECT s."deliveryId" AS "id" FROM "route_stops" AS s JOIN "deliveries" AS d ON d."id" = s."deliveryId"
                        WHERE s."routeId" = $1 AND d."routeId" IS DISTINCT FROM s."routeId" AND d."updatedAt" > $2::timestamp""", route_id, after),
        _stop_counts([route_id]),
        db.delivery.find_many(where={"routeId": route_id, "status": {"in": list(OPEN)}}, order=[{"stopOrder": "asc"}, {"id": "asc"}], take=1),
    )
    route_counts = counts.get(route_id, {})
    return {
        "cursor": iso(cursor), "route": _header(route, route_counts, next_rows[0].id if next_rows else None),
        "stops": [light_stop(r) for r in changed], "removed": [r["id"] for r in removed], "stopCount": sum(route_counts.values()),
    }


async def route_summary(route_id: str | None) -> dict | None:
    """The route block returned with a stop event: progress and what is next, without the stops."""
    if not route_id:
        return None
    route, counts, next_rows = await asyncio.gather(
        db.route.find_unique(where={"id": route_id}), _stop_counts([route_id]),
        db.delivery.find_many(where={"routeId": route_id, "status": {"in": list(OPEN)}}, order=[{"stopOrder": "asc"}, {"id": "asc"}], take=1),
    )
    if not route:
        return None
    header = _header(route, counts.get(route_id, {}), next_rows[0].id if next_rows else None)
    return {k: header[k] for k in ("id", "status", "progress", "summary", "nextStopId")}


# ---------- Home ----------

async def home(actor: dict, date: str) -> dict:
    """Everything the Home screen shows, in one response: today's totals, open routes from today on (with stop counts),
    stops added but not planned yet (per day), open stops left from earlier days, and the plan status."""
    _require_rider(actor)
    rider_id = actor["id"]
    today_where = {"riderId": rider_id, "OR": [{"serviceDate": date}, {"status": {"in": list(OPEN)}, "serviceDate": {"lte": date}}]}
    status_rows, routes, unplanned_rows, left_rows, subscription = await asyncio.gather(
        db.delivery.group_by(by=["status"], where=today_where, count=True),
        db.route.find_many(where={"riderId": rider_id, "status": {"in": ["planned", "active"]}, "serviceDate": {"gte": date}},
                           order=[{"serviceDate": "asc"}, {"createdAt": "asc"}, {"id": "asc"}], take=100),
        db.delivery.group_by(by=["serviceDate"], where={"riderId": rider_id, "status": "pending", "routeId": None, "serviceDate": {"gte": date}},
                             count=True),
        db.delivery.group_by(by=["serviceDate"], where=_left_over_where(actor, date), count=True),
        db.subscription.find_unique(where={"userId": rider_id}),
    )
    today = summarize_counts({str(r["status"]): r["_count"]["_all"] for r in status_rows})
    finished = today["delivered"] + today["failed"]
    counts = await _stop_counts([r.id for r in routes])
    left = {r["serviceDate"]: r["_count"]["_all"] for r in left_rows}
    return {
        "rider": {"fullName": actor["fullName"]},
        "date": date,
        "today": {"total": today["total"], "delivered": today["delivered"], "failed": today["failed"],
                  "progressPercent": js_round(finished / today["total"] * 100) if today["total"] else 0},
        "routes": [{"id": r.id, "name": r.name or None, "status": str(r.status), "serviceDate": r.serviceDate,
                    "stops": sum(counts.get(r.id, {}).values())} for r in routes],
        "unplanned": sorted(({"date": r["serviceDate"], "count": r["_count"]["_all"]} for r in unplanned_rows), key=lambda d: d["date"]),
        "leftOver": {"total": sum(left.values()), "days": [{"date": k, "count": left[k]} for k in sorted(left, reverse=True)]},
        # Home's "Free trial" / "Upgrade" chip shows for these statuses: no separate /subscriptions/me request on Home.
        "plan": {"status": effective_status(subscription) if subscription else "inactive"},
    }


# ---------- Stop events ----------

async def stop_event(actor: dict, stop_id: str, kind: str, *, reason: str | None = None, note: str | None = None, allow_skip: bool = False) -> dict:
    """arrive / deliver / fail in one call. Deliver and fail on a stop not yet arrived at record the arrival first.
    Repeating an event the stop already went through answers with the stop as it is (no second change)."""
    _require_rider(actor)
    stop = await deliveries.find_visible(actor, stop_id)
    status = str(stop.status)
    done = {"arrive": ("in_progress", "delivered", "failed"), "deliver": ("delivered",), "fail": ("failed",)}[kind]
    if status not in done:
        if kind != "arrive" and status == "pending":
            await deliveries.arrive(actor, stop_id)
        if kind == "arrive":
            await deliveries.arrive(actor, stop_id)
        elif kind == "deliver":
            await deliveries.deliver(actor, stop_id, note=note, allow_skip=allow_skip)
        else:
            await deliveries.fail(actor, stop_id, reason=reason or "other", note=note)
        stop = await deliveries.find_visible(actor, stop_id)
    return {"stop": light_stop_of(stop), "route": await route_summary(stop.routeId)}


# ---------- Batch create ----------

async def create_batch(actor: dict, items: list[dict]) -> tuple[int, dict]:
    """Creates the stops whose clientId this rider has not sent before; the others are returned as they are.
    So the whole batch can be sent again after a lost response without making a single duplicate."""
    _require_rider(actor)
    client_ids = [i["clientId"] for i in items]
    if len(set(client_ids)) != len(client_ids):
        raise validation_error([{"path": "items", "message": "Each clientId may appear only once in a batch"}])

    async with transaction() as tx:
        await lock_rider(tx, actor["id"])
        known = {d.clientId for d in await tx.delivery.find_many(where={"riderId": actor["id"], "clientId": {"in": client_ids}})}
        new_items = [i for i in items if i["clientId"] not in known]
        if new_items:
            await assert_can_create_deliveries(actor, len(new_items), tx)
            tracking = [i["trackingId"] for i in new_items if i.get("trackingId")]
            taken = {d.trackingId for d in await tx.delivery.find_many(where={"riderId": actor["id"], "trackingId": {"in": tracking}})} if tracking else set()
            details, seen = [], set()
            for index, item in enumerate(items):
                tid = item.get("trackingId")
                if item["clientId"] in known or not tid:
                    continue
                if tid in taken or tid in seen:
                    details.append({"index": index, "path": "trackingId", "code": "DUPLICATE",
                                    "message": f"Parcel ID {tid} {'already exists' if tid in taken else 'appears more than once'}"})
                seen.add(tid)
            if details:
                raise conflict("Some deliveries are duplicates", "DUPLICATE_TRACKING_ID", details)
            rows = [{**await deliveries._to_row(actor, item), "clientId": item["clientId"]} for item in new_items]
            await tx.delivery.create_many(data=rows)

    saved = {d.clientId: d for d in await db.delivery.find_many(where={"riderId": actor["id"], "clientId": {"in": client_ids}})}
    stops = [{**light_stop_of(saved[c]), "clientId": c, "serviceDate": saved[c].serviceDate, "routeId": saved[c].routeId} for c in client_ids]
    status = 201 if new_items else 200
    return status, {"stops": stops, "created": len(new_items), "existing": len(items) - len(new_items)}


# ---------- Proof photo ----------

async def upload_proof(actor: dict, stop_id: str, file: UploadedFile | None) -> dict:
    """Proof for a stop being delivered or already delivered (an offline phone uploads it after the deliver event)."""
    _require_rider(actor)
    saved = await deliveries.attach_proof(actor, stop_id, file, allow_delivered=True)
    return {"stopId": stop_id, "proof": saved["proof"]}
