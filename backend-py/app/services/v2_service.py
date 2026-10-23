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

from ..db import as_json, db, lock_rider, transaction
from ..errors import AppError, conflict, forbidden, not_found, validation_error
from ..http import iso, js_round, now, today_key
from ..uploads import UploadedFile
from . import delivery_service as deliveries
from . import routing_service
from .geocoding_service import find_eircode, normalize_eircodes
from .route_service import OPEN, _left_over_where, _stop_counts, find_current, on_stop_finished, route_summaries, summarize_counts
from .serializers import clean_delivery_address
from .stop_event_service import event_time
from .stop_event_service import record as record_event
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


async def current_route(actor: dict, date: str) -> dict | None:
    """The route underway, else the latest one planned for `date` or earlier (as v1 /routes/current), light; None if none."""
    route = await find_current(actor, date)
    return await get_route(actor, route.id) if route else None


async def completed_routes(actor: dict, before: str | None, limit: int) -> dict:
    """Finished routes, newest first, without their stops (History, Reports). `next` is the `before` of the next page."""
    _require_rider(actor)
    where: dict[str, Any] = {"riderId": actor["id"], "status": "completed", "completedAt": {"not": None}}
    if before:
        at, _, last_id = before.partition("_")
        at_time = parse_cursor(at)
        where["OR"] = [{"completedAt": {"lt": at_time}}, {"completedAt": at_time, "id": {"lt": last_id}}]
    rows = await db.route.find_many(where=where, order=[{"completedAt": "desc"}, {"id": "desc"}], take=limit + 1)
    page = rows[:limit]
    return {"routes": await route_summaries(page), "next": f"{iso(page[-1].completedAt)}_{page[-1].id}" if len(rows) > limit else None}


def parse_cursor(value: str) -> datetime:
    try:
        at = datetime.fromisoformat(value)
    except ValueError:
        raise validation_error([{"path": "since", "message": "Must be a cursor returned by this API"}]) from None
    return at if at.tzinfo else at.replace(tzinfo=UTC)


async def route_changes(actor: dict, route_id: str, since: datetime) -> dict:
    """What changed on the route since `since` (a previous `cursor`). The client applies `stops` by id and drops `removed`
    (moved to another route or deleted); `stopCount` lets it check it is in step."""
    _require_rider(actor)
    cursor = now()
    after = (since - CHANGES_SLACK).astimezone(UTC).replace(tzinfo=None).isoformat()
    route, changed, removed, counts, next_rows = await asyncio.gather(
        _mine(actor, route_id),
        db.query_raw(_STOPS_SQL, route_id, after),
        # Stops moved to another route, and stops deleted from this one (kept in deleted_deliveries since P4.6).
        db.query_raw("""SELECT s."deliveryId" AS "id" FROM "route_stops" AS s JOIN "deliveries" AS d ON d."id" = s."deliveryId"
                        WHERE s."routeId" = $1 AND d."routeId" IS DISTINCT FROM s."routeId" AND d."updatedAt" > $2::timestamp
                        UNION
                        SELECT x."id" FROM "deleted_deliveries" AS x WHERE x."routeId" = $1 AND x."deletedAt" > $2::timestamp""", route_id, after),
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

async def stop_event(actor: dict, stop_id: str, kind: str, *, reason: str | None = None, note: str | None = None, allow_skip: bool = False,
                     at: datetime | None = None, idempotency_key: str | None = None) -> dict:
    """arrive / deliver / fail in one call; every one is recorded in stop_events.

    - Deliver and fail on a stop not yet arrived at record the arrival first.
    - Repeating an event the stop already went through changes nothing (outcome no_change).
    - Two devices / phones syncing late: `at` is when it happened on the phone. An event older than the stop's latest one
      changes nothing (superseded); a newer deliver/fail replaces an earlier fail/deliver. (Team default: last event wins.)
    """
    _require_rider(actor)
    at = event_time(at)
    stop = await deliveries.find_visible(actor, stop_id)
    status = str(stop.status)
    target = {"arrive": "in_progress", "deliver": "delivered", "fail": "failed"}[kind]

    async def log(outcome: str, to_status: str, event: str = kind) -> None:
        await record_event(stop, event, outcome, to_status, at=at, source="v2", reason=reason if event == "fail" else None, note=note,
                           idempotency_key=idempotency_key)

    try:
        if stop.lastEventAt and at < stop.lastEventAt:
            await log("superseded", status)
        elif status == target or (kind == "arrive" and status in ("delivered", "failed")):
            await log("no_change", status)
        elif status in ("delivered", "failed"):
            await _switch_outcome(stop, kind, at, reason, note)
            await log("applied", target)
        else:
            if status == "pending":
                await deliveries.arrive(actor, stop_id, at=at, audit=False)
                await log("applied", "in_progress", "arrive")
            if kind == "deliver":
                await deliveries.deliver(actor, stop_id, note=note, allow_skip=allow_skip, at=at, audit=False)
            elif kind == "fail":
                await deliveries.fail(actor, stop_id, reason=reason or "other", note=note, at=at, audit=False)
            if kind != "arrive":  # an arrival on its own was logged above
                await log("applied", target)
    except AppError:
        await log("rejected", status)
        raise
    stop = await deliveries.find_visible(actor, stop_id)
    return {"stop": light_stop_of(stop), "route": await route_summary(stop.routeId)}


async def _switch_outcome(stop: Any, kind: str, at: datetime, reason: str | None, note: str | None) -> None:
    """A newer deliver/fail for a finished stop (e.g. the rider's other phone): delivered becomes failed or the reverse."""
    if kind == "deliver":
        data = {"status": "delivered", "deliveredAt": at, "failedAt": None, "failureReason": None, "failureNote": None, "lastEventAt": at}
        if note:
            data["note"] = note
    else:
        data = {"status": "failed", "failedAt": at, "deliveredAt": None, "failureReason": reason or "other", "failureNote": note, "lastEventAt": at}
    await deliveries.save_delivery(stop, data)
    if stop.routeId:
        await on_stop_finished(stop.routeId)


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
            await _check_second_parcels(tx, actor, items, known)
            rows = [{**await deliveries._to_row(actor, item), "clientId": item["clientId"], "secondParcel": bool(item.get("secondParcel"))}
                    for item in new_items]
            await tx.delivery.create_many(data=rows)

    saved = {d.clientId: d for d in await db.delivery.find_many(where={"riderId": actor["id"], "clientId": {"in": client_ids}})}
    stops = [{**light_stop_of(saved[c]), "clientId": c, "serviceDate": saved[c].serviceDate, "routeId": saved[c].routeId} for c in client_ids]
    status = 201 if new_items else 200
    return status, {"stops": stops, "created": len(new_items), "existing": len(items) - len(new_items)}


def _eircode_of(item: dict) -> str | None:
    address = item.get("address") or {}
    return find_eircode(normalize_eircodes(address.get("raw") or "")) or find_eircode(address.get("normalized") or "")


async def _check_second_parcels(tx: Any, actor: dict, items: list[dict], known: set) -> None:
    """Same Eircode on the same day as a stop already added (or earlier in this batch): refused unless the rider confirmed
    it is a second parcel for that address (`secondParcel`). Team default: warn + "second parcel" confirmation."""
    wanted = [(i, item, _eircode_of(item), item.get("serviceDate") or today_key()) for i, item in enumerate(items) if item["clientId"] not in known]
    wanted = [w for w in wanted if w[2]]
    if not wanted:
        return
    existing = await tx.delivery.find_many(where={"riderId": actor["id"], "postalCode": {"in": list({w[2] for w in wanted})},
                                                  "serviceDate": {"in": list({w[3] for w in wanted})}})
    seen = {(d.postalCode, d.serviceDate): d.id for d in existing}
    details = []
    for index, item, code, day in wanted:
        if (code, day) in seen and not item.get("secondParcel"):
            details.append({"index": index, "path": "address", "code": "SAME_EIRCODE_SAME_DAY", "postalCode": code, "serviceDate": day,
                            "existingId": seen[(code, day)], "message": f"{code} is already on {day}. Add it as a second parcel?"})
        seen.setdefault((code, day), item["clientId"])
    if details:
        raise conflict("A stop with this Eircode is already on that day", "SAME_EIRCODE_SAME_DAY", details)


# ---------- Proof photo ----------

async def upload_proof(actor: dict, stop_id: str, file: UploadedFile | None) -> dict:
    """Proof for a stop being delivered or already delivered (an offline phone uploads it after the deliver event)."""
    _require_rider(actor)
    saved = await deliveries.attach_proof(actor, stop_id, file, allow_delivered=True)
    return {"stopId": stop_id, "proof": saved["proof"]}


# ---------- Road lines (P6b.4) and navigation (P6b.5), from our OSRM: the app never calls an OSRM server ----------

async def route_geometry(actor: dict, route_id: str) -> tuple[str, dict]:
    """(version, line) for the route: the road path from its start through the open located stops in route order, with
    each stop's leg. Made once per route version (its ETag) and kept in route_geometries. path is None without a road
    router (the app then draws straight lines)."""
    version = await route_etag(actor, route_id)
    cached = await db.routegeometry.find_unique(where={"routeId": route_id})
    if cached and cached.version == version:
        return version, cached.data
    route, rows = await asyncio.gather(_mine(actor, route_id), db.query_raw(_STOPS_SQL, route_id, None))
    stops = [r for r in rows if r["status"] in OPEN and r["addressGeocoded"] and r["addressLatitude"] is not None]
    origin = [{"latitude": route.originLatitude, "longitude": route.originLongitude}] if route.originLatitude is not None else []
    points = origin + [{"latitude": r["addressLatitude"], "longitude": r["addressLongitude"]} for r in stops]
    road = await routing_service.road_path(points)
    legs = (road or {}).get("legs") or []
    if origin:
        stop_legs = legs
    else:  # without a start point the first stop has no leg
        stop_legs = [{"distanceKm": 0, "durationMin": 0}, *legs]
    data = {
        "path": road["path"] if road else None,
        "legs": [{"stopId": r["id"], **leg} for r, leg in zip(stops, stop_legs)] if road else [],
        "distanceKm": road["distanceKm"] if road else None, "durationMin": road["durationMin"] if road else None,
    }
    if road:  # a missing router is not cached: the line appears once it is back
        payload = as_json(data)
        await db.routegeometry.upsert(where={"routeId": route_id}, data={"create": {"routeId": route_id, "version": version, "data": payload},
                                                                         "update": {"version": version, "data": payload}})
    return version, data


async def navigation_route(start: dict, target: dict) -> dict:
    """Turn-by-turn from the rider to the next stop: {path, distanceKm, durationMin, steps}; path None without a router."""
    road = await routing_service.road_path([start, target], steps=True)
    return road or {"path": None, "distanceKm": None, "durationMin": None, "steps": []}
