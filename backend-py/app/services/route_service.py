from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from prisma.errors import UniqueViolationError

from ..db import db, lock_rider, transaction
from ..errors import AppError, conflict, forbidden, not_found, unprocessable
from ..http import js_round, now, round2, today_key
from ..ids import new_id
from ..logger import log
from . import geocoding_service as geocoding
from . import jobs, optimizer
from .geo import haversine_km, normalize_address
from .serializers import clean_delivery_address, serialize_delivery
from .settings_service import get_settings

OPEN = ("pending", "in_progress")
ROUTE_ROAD_FACTOR = 1.3
_FRESH_ADDRESS = {"addressNormalized": None, "addressLatitude": None, "addressLongitude": None, "addressGeocoded": False,
                  "addressApproximate": False, "geocodeStatus": "pending"}


def summarize(deliveries: list[Any], route: Any = None) -> dict:
    counts: dict[str, int] = {}
    for d in deliveries:
        counts[str(d.status)] = counts.get(str(d.status), 0) + 1
    return summarize_counts(counts, route)


def summarize_counts(counts: dict[str, int], route: Any = None) -> dict:
    """The same summary from {status: number of stops}, for callers that count in SQL instead of loading rows."""
    minutes = None
    if route is not None and route.startedAt and route.completedAt:
        minutes = max(1, js_round((route.completedAt - route.startedAt).total_seconds() / 60))
    return {
        "total": sum(counts.values()),
        "delivered": counts.get("delivered", 0),
        "failed": counts.get("failed", 0),
        "pending": sum(n for status, n in counts.items() if status in OPEN),
        "distanceKm": route.distanceKm if route is not None and route.distanceKm is not None else 0,
        "routeMinutes": minutes,
    }


def _origin(route: Any) -> dict | None:
    if route.originLatitude is None:
        return None
    return {"latitude": route.originLatitude, "longitude": route.originLongitude}


async def serialize_routes(routes: list[Any]) -> list[dict]:
    """Full routes with their stops: two queries however many routes there are."""
    if not routes:
        return []
    ids = [r.id for r in routes]
    stop_rows = await db.routestop.find_many(where={"routeId": {"in": ids}})
    # A stop carried over to another day keeps its row here for the record, but belongs to its new route now.
    deliveries = await db.delivery.find_many(where={"routeId": {"in": ids}}) if stop_rows else []
    by_id = {d.id: d for d in deliveries}
    rows_by_route: dict[str, list[Any]] = {}
    for s in stop_rows:
        rows_by_route.setdefault(s.routeId, []).append(s)
    return [_serialize_route(route, sorted(rows_by_route.get(route.id, []), key=lambda s: s.order), by_id) for route in routes]


async def serialize_route(route: Any) -> dict:
    return (await serialize_routes([route]))[0]


def _serialize_route(route: Any, stop_rows: list[Any], by_id: dict[str, Any]) -> dict:
    mine = [s for s in stop_rows if s.deliveryId in by_id and by_id[s.deliveryId].routeId == route.id]
    stops = [
        {"order": i + 1, "legDistanceKm": s.legDistanceKm, "legDurationMin": s.legDurationMin, "delivery": serialize_delivery(by_id[s.deliveryId])}
        for i, s in enumerate(mine)
    ]
    done = sum(1 for s in stops if s["delivery"]["status"] not in OPEN)
    current = next((s for s in stops if s["delivery"]["status"] in OPEN), None)
    # A day can have several routes, and stops on no route belong to one still being added (Add stops), not to this
    # one, so nothing is pulled in automatically any more. Kept in the response for older app versions.
    new_stops = 0
    return {
        "id": route.id, "name": route.name or None, "status": str(route.status), "preference": str(route.preference), "serviceDate": route.serviceDate,
        "origin": _origin(route),
        "distanceKm": route.distanceKm, "durationMin": route.durationMin, "startedAt": route.startedAt, "completedAt": route.completedAt,
        "optimization": route.optimization, "newStops": new_stops,
        "stops": stops, "progress": {"total": len(stops), "done": done, "remaining": len(stops) - done},
        "currentStopId": current["delivery"]["id"] if current else None,
        "summary": summarize([by_id[s["delivery"]["id"]] for s in stops], route),
    }


def _require_rider(actor: dict) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders manage routes")


async def _release_planned(client: Any, route_ids: list[str]) -> None:
    """Replanning a day replaces that day's unstarted route; routes planned for other days stay."""
    await client.delivery.update_many(where={"routeId": {"in": route_ids}, "status": "pending"}, data={"routeId": None, "stopOrder": None})
    await client.route.delete_many(where={"id": {"in": route_ids}})


def area_of_user(user: Any) -> dict | None:
    if not user or not user.areaCity or not user.areaCountryCode:
        return None
    return {"city": user.areaCity, "country": user.areaCountry, "countryCode": user.areaCountryCode, "latitude": user.areaLatitude,
            "longitude": user.areaLongitude, "source": str(user.areaSource) if user.areaSource else None, "confirmedAt": user.areaConfirmedAt}


async def service_area_for(actor: dict, origin: dict | None) -> dict | None:
    """The rider's service area. Riders who never confirmed a city get one detected from the route's start point."""
    from .auth_service import area_columns

    user = await db.user.find_unique(where={"id": actor["id"]})
    area = area_of_user(user)
    if area:
        return area
    if not origin:
        return None
    try:
        detected = await geocoding.detect_service_area(origin)
    except Exception:  # noqa: BLE001
        detected = None
    if not detected:
        return None
    user = await db.user.update(where={"id": actor["id"]}, data=area_columns(detected, "gps"))
    return area_of_user(user)


# Every stop the lookup changed is saved in one statement. Like save_delivery it only lands on rows nobody saved since
# they were read (same version), so a parallel edit is never overwritten.
_SAVE_GEOCODES_SQL = """
UPDATE "deliveries" AS d SET
  "addressRaw" = v."addressRaw", "addressNormalized" = v."addressNormalized", "addressLatitude" = v."addressLatitude",
  "addressLongitude" = v."addressLongitude", "addressGeocoded" = v."addressGeocoded", "addressApproximate" = v."addressApproximate",
  "geocodeStatus" = v."geocodeStatus"::"GeocodeStatus", "postalCode" = v."postalCode",
  "version" = d."version" + 1, "updatedAt" = timezone('utc', now())
FROM jsonb_to_recordset($1::jsonb) AS v(id text, version int, "addressRaw" text, "addressNormalized" text, "addressLatitude" float8,
  "addressLongitude" float8, "addressGeocoded" boolean, "addressApproximate" boolean, "geocodeStatus" text, "postalCode" text)
WHERE d."id" = v.id AND d."version" = v.version
"""
_GEOCODE_COLUMNS = ("addressRaw", "addressNormalized", "addressLatitude", "addressLongitude", "addressGeocoded", "addressApproximate",
                    "geocodeStatus", "postalCode")


async def _refresh_delivery_geocodes(deliveries: list[Any], *, retry_approximate: bool = False, area: dict | None = None) -> list[Any]:
    """Looks up stops without coordinates. Returns the deliveries as saved (same order).
    A stop whose lookup failed (provider error) keeps its state, so a later retry looks it up again."""
    out = list(deliveries)
    changed: set[int] = set()

    def update(i: int, data: dict) -> None:
        out[i] = out[i].model_copy(update=data)
        changed.add(i)

    for i, d in enumerate(out):
        clean = clean_delivery_address(d.addressRaw, d.payment)
        if clean != d.addressRaw:
            update(i, {"addressRaw": clean, **_FRESH_ADDRESS})

    # On a retry, also redo "found" stops that sit outside the rider's city (e.g. matched abroad before areas existed).
    def outside_area(d: Any) -> bool:
        point = {"latitude": d.addressLatitude, "longitude": d.addressLongitude}
        return bool(retry_approximate and area and d.geocodeStatus == "found" and not geocoding.is_inside_area(point, area))

    todo = [i for i, d in enumerate(out)
            if outside_area(d) or (d.geocodeStatus != "found" and (retry_approximate or d.geocodeStatus != "approximate"))]
    failed: set[str] = set()
    results = await geocoding.geocode_many([out[i].addressRaw for i in todo], failed=failed,
                                           retry_approximate=retry_approximate or any(outside_area(out[i]) for i in todo), area=area) if todo else {}
    for i in todo:
        d = out[i]
        if d.addressRaw in failed:
            continue
        hit = results.get(d.addressRaw)
        if hit:
            approx = bool(hit.get("approximate"))
            # An Eircode point is a building, so it orders the route even when the provider calls it approximate.
            data = {"addressLatitude": hit["latitude"], "addressLongitude": hit["longitude"], "addressNormalized": hit.get("normalized"),
                    "addressGeocoded": not approx or bool(hit.get("eircode")), "addressApproximate": approx,
                    "geocodeStatus": "approximate" if approx else "found"}
            if hit.get("postalCode") and not d.postalCode:
                data["postalCode"] = hit["postalCode"]
        else:
            data = {"addressLatitude": None, "addressLongitude": None, "addressNormalized": None, "addressGeocoded": False,
                    "addressApproximate": False, "geocodeStatus": "not_found"}
        update(i, data)

    if not changed:
        return out
    rows = [{"id": out[i].id, "version": out[i].version, **{c: getattr(out[i], c) for c in _GEOCODE_COLUMNS}} for i in sorted(changed)]
    for row in rows:
        row["geocodeStatus"] = str(row["geocodeStatus"])
    if await db.execute_raw(_SAVE_GEOCODES_SQL, json.dumps(rows)) != len(rows):
        raise conflict("This record was changed by someone else. Refresh and try again.")
    saved = {d.id: d for d in await db.delivery.find_many(where={"id": {"in": [r["id"] for r in rows]}})}
    return [saved.get(d.id, d) for d in out]


async def _plan(deliveries: list[Any], origin: dict | None, preference: str, settings: dict, first_order: int = 1) -> tuple[list[dict], float, float, str]:
    """Orders the stops. Only verified locations are optimised; unresolved (or approximate) ones go last.
    Returns (stops, distanceKm, durationMin, optimization) where optimization is "road" or "straight_line"."""
    located = [d for d in deliveries if d.addressGeocoded]
    unlocated = [d for d in deliveries if not d.addressGeocoded]
    # VROOM when available, else the built-in planner, which runs in the worker process for anything but tiny routes
    # (P6b.1/P6b.2): the API process never does heavy ordering work itself.
    plan = await optimizer.plan(
        origin, [{"id": d.id, "latitude": d.addressLatitude, "longitude": d.addressLongitude, "addressKey": normalize_address(d.addressRaw)} for d in located],
        preference, settings,
    )
    stops = [
        *({"deliveryId": did, "order": first_order + i, "legDistanceKm": plan["legs"][i]["distanceKm"], "legDurationMin": plan["legs"][i]["durationMin"]}
          for i, did in enumerate(plan["order"])),
        *({"deliveryId": d.id, "order": first_order + len(plan["order"]) + i, "legDistanceKm": 0, "legDurationMin": 0} for i, d in enumerate(unlocated)),
    ]
    return (stops, plan["distanceKm"], plan["durationMin"] + len(unlocated) * settings["route"]["stopServiceMinutes"], plan["optimization"])



# One statement for the whole route, however many stops (it used to be one UPDATE per stop).
_ASSIGN_SQL = """
UPDATE "deliveries" AS d SET "routeId" = $1, "stopOrder" = v."order", "updatedAt" = timezone('utc', now())
FROM jsonb_to_recordset($3::jsonb) AS v("deliveryId" text, "order" int)
WHERE d."id" = v."deliveryId" AND d."riderId" = $2
"""


_LEGS_SQL = """
UPDATE "route_stops" AS rs SET "legDistanceKm" = v.km, "legDurationMin" = v.min
FROM jsonb_to_recordset($2::jsonb) AS v("deliveryId" text, km float8, min float8)
WHERE rs."routeId" = $1 AND rs."deliveryId" = v."deliveryId"
"""


async def _assign_stops(client: Any, route_id: str, rider_id: str, stops: list[dict]) -> None:
    if stops:
        await client.execute_raw(_ASSIGN_SQL, route_id, rider_id, json.dumps([{"deliveryId": s["deliveryId"], "order": s["order"]} for s in stops]))


async def _assert_no_active_route(client: Any, actor: dict, date: str) -> None:
    active = await client.route.find_first(where={"riderId": actor["id"], "status": "active"})
    # A route for a later day can be planned while today's is underway (e.g. tomorrow's, the night before).
    if active and active.serviceDate >= date:
        raise conflict("Finish or end your active route before planning a new one", "ROUTE_ACTIVE")


def _stops_changed() -> AppError:
    return conflict("Your stops changed while the route was being planned. Please try again.", "ROUTE_STALE")


async def build(actor: dict, *, preference: str | None = None, origin: dict | None = None, delivery_ids: list[str] | None = None,
                date: str | None = None, name: str | None = None) -> dict:
    _require_rider(actor)
    date = date or today_key()
    await _assert_no_active_route(db, actor, date)

    where: dict[str, Any] = {"riderId": actor["id"], "status": "pending"}
    if delivery_ids:
        # A new route takes exactly the stops chosen for it. Every other route of the day stays as it is; a chosen stop
        # that is still on another unstarted route (planned again) moves over, and that route is tidied up afterwards.
        released: list[str] = []
        movable = [r.id for r in await db.route.find_many(where={"riderId": actor["id"], "status": "planned"})]
        where |= {"id": {"in": delivery_ids}}
    else:
        # No stops chosen: (re)plan the whole day, replacing its unstarted route. The day's open stops (and older ones
        # still open), never stops already added for a later day.
        released = [r.id for r in await db.route.find_many(where={"riderId": actor["id"], "status": "planned", "serviceDate": date})]
        movable = released
        where |= {"serviceDate": {"lte": date}}
    where["OR"] = [{"routeId": None}, *([{"routeId": {"in": movable}}] if movable else [])]
    deliveries = await db.delivery.find_many(where=where, order=[{"createdAt": "asc"}, {"id": "asc"}])
    if not deliveries:
        raise unprocessable("Add deliveries before building a route", "NO_DELIVERIES")
    previous_routes = {d.routeId for d in deliveries if d.routeId} - set(released)

    settings, user = await asyncio.gather(get_settings(), db.user.find_unique(where={"id": actor["id"]}))
    pref = preference or (str(user.routePreference) if user else None) or settings["route"]["defaultPreference"]

    # Geocode before ordering so stop numbers reflect destination order, not entry order. Lookups and ordering take a
    # while, so they happen before the transaction; the writes below are all-or-nothing under the rider's lock.
    deliveries = await _refresh_delivery_geocodes(deliveries, area=await service_area_for(actor, origin))
    stops, distance_km, duration_min, optimization = await _plan(deliveries, origin, pref, settings)
    ids = [s["deliveryId"] for s in stops]

    async with transaction() as tx:
        await lock_rider(tx, actor["id"])
        await _assert_no_active_route(tx, actor, date)
        if released:
            await _release_planned(tx, released)
        # The stops must still be free: a parallel build or a delete may have taken some while this one was planned.
        free = [{"routeId": None}, *([{"routeId": {"in": list(previous_routes)}}] if previous_routes else [])]
        if await tx.delivery.count(where={"id": {"in": ids}, "riderId": actor["id"], "status": "pending", "OR": free}) != len(ids):
            raise _stops_changed()
        route = await tx.route.create(data={
            "id": new_id(), "riderId": actor["id"], "serviceDate": date, "name": name or None, "preference": pref,
            "status": "planned", "originLatitude": origin["latitude"] if origin else None, "originLongitude": origin["longitude"] if origin else None,
            "distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization,
        })
        await tx.routestop.create_many(data=[{"routeId": route.id, **s} for s in stops])
        await _assign_stops(tx, route.id, actor["id"], stops)
        if previous_routes:
            await _drop_moved_stops(tx, previous_routes, ids)
    return await serialize_route(route)


async def _drop_moved_stops(client: Any, route_ids: set[str], delivery_ids: list[str]) -> None:
    """Takes stops that moved to a new route off the unstarted routes they were on; a route left empty is deleted."""
    await client.routestop.delete_many(where={"routeId": {"in": list(route_ids)}, "deliveryId": {"in": delivery_ids}})
    await client.execute_raw("""DELETE FROM "routes" AS r WHERE r."id" IN (SELECT jsonb_array_elements_text($1::jsonb)) AND r."status" = 'planned'
                                AND NOT EXISTS (SELECT 1 FROM "route_stops" AS s WHERE s."routeId" = r."id")""", json.dumps(sorted(route_ids)))


async def _lock_route(tx: Any, actor: dict, route_id: str, stop_ids: list[str], states: tuple[str, ...]) -> None:
    """Under the rider's lock: the route is still in one of `states` and still has exactly the stops it was planned with."""
    await lock_rider(tx, actor["id"])
    route = await tx.route.find_first(where={"id": route_id, "riderId": actor["id"]})
    if not route or str(route.status) not in states:
        raise _stops_changed()
    if await tx.delivery.count(where={"routeId": route_id}) != len(stop_ids) or (
            stop_ids and await tx.delivery.count(where={"routeId": route_id, "id": {"in": stop_ids}}) != len(stop_ids)):
        raise _stops_changed()


async def retry_geocoding(actor: dict, route_id: str) -> dict:
    _require_rider(actor)
    route = await _find_mine(actor, route_id)
    if route.status not in ("planned", "active"):
        raise conflict("Only planned or active routes can retry address lookup", "INVALID_STATE")
    stop_rows = await db.routestop.find_many(where={"routeId": route.id})
    deliveries = await db.delivery.find_many(where={"riderId": actor["id"], "routeId": route.id, "id": {"in": [s.deliveryId for s in stop_rows]}},
                                             order=[{"createdAt": "asc"}, {"id": "asc"}])
    origin = _origin(route)
    area = await service_area_for(actor, origin)
    deliveries = await _refresh_delivery_geocodes(deliveries, retry_approximate=True, area=area)

    settings, user = await asyncio.gather(get_settings(), db.user.find_unique(where={"id": actor["id"]}))
    by_id = {d.id: d for d in deliveries}

    if route.status == "planned":
        pref = str(route.preference) or (str(user.routePreference) if user else None) or settings["route"]["defaultPreference"]
        stops, distance_km, duration_min, optimization = await _plan(deliveries, origin, pref, settings)
        async with transaction() as tx:
            await _lock_route(tx, actor, route.id, [d.id for d in deliveries], ("planned",))
            await tx.routestop.delete_many(where={"routeId": route.id})
            await tx.routestop.create_many(data=[{"routeId": route.id, **s} for s in stops])
            route = await tx.route.update(where={"id": route.id}, data={"distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization})
            await _assign_stops(tx, route.id, actor["id"], stops)
    else:
        previous = origin
        distance_km = 0.0
        travel = 0
        legs = []
        for stop in sorted(stop_rows, key=lambda s: s.order):
            d = by_id.get(stop.deliveryId)
            if not d or not d.addressGeocoded:
                previous = None
                continue
            point = {"latitude": d.addressLatitude, "longitude": d.addressLongitude}
            distance = round2(haversine_km(previous, point) * ROUTE_ROAD_FACTOR) if previous else 0
            minutes = js_round((distance / settings["route"]["avgSpeedKmh"]) * 60)
            legs.append({"deliveryId": stop.deliveryId, "km": distance, "min": minutes})
            distance_km += distance
            travel += minutes
            previous = point
        async with transaction() as tx:
            await lock_rider(tx, actor["id"])
            if legs:
                await tx.execute_raw(_LEGS_SQL, route.id, json.dumps(legs))
            route = await tx.route.update(where={"id": route.id}, data={
                "distanceKm": round2(distance_km), "durationMin": travel + len(stop_rows) * settings["route"]["stopServiceMinutes"],
            })
    return await serialize_route(route)


async def optimize(actor: dict, route_id: str, origin: dict | None = None) -> dict:
    """Re-optimises the open stops of a planned or active route from `origin` (the rider's position;
    defaults to the route's start). Only the route's own stops: stops on no route are never pulled in, since they
    belong to a route that is still being added. Finished stops keep their place."""
    _require_rider(actor)
    route = await _find_mine(actor, route_id)
    if route.status not in ("planned", "active"):
        raise conflict("Only planned or active routes can be optimised", "INVALID_STATE")
    stop_rows = sorted(await db.routestop.find_many(where={"routeId": route.id}), key=lambda s: s.order)
    on_route = await db.delivery.find_many(where={"riderId": actor["id"], "routeId": route.id, "id": {"in": [s.deliveryId for s in stop_rows]}})
    by_id = {d.id: d for d in on_route}
    finished = [by_id[s.deliveryId] for s in stop_rows if s.deliveryId in by_id and str(by_id[s.deliveryId].status) not in OPEN]
    open_stops = [by_id[s.deliveryId] for s in stop_rows if s.deliveryId in by_id and str(by_id[s.deliveryId].status) in OPEN]
    start_point = origin or _origin(route)

    open_stops = await _refresh_delivery_geocodes(open_stops, area=await service_area_for(actor, start_point))
    settings, user = await asyncio.gather(get_settings(), db.user.find_unique(where={"id": actor["id"]}))
    pref = str(route.preference) or (str(user.routePreference) if user else None) or settings["route"]["defaultPreference"]
    stops, distance_km, duration_min, optimization = await _plan(open_stops, start_point, pref, settings, first_order=len(finished) + 1)

    keep = {s.deliveryId: s for s in stop_rows}
    finished_rows = [{"deliveryId": d.id, "order": i + 1, "legDistanceKm": keep[d.id].legDistanceKm, "legDurationMin": keep[d.id].legDurationMin}
                     for i, d in enumerate(finished)]
    data: dict[str, Any] = {"distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization}
    if origin:
        data |= {"originLatitude": origin["latitude"], "originLongitude": origin["longitude"]}
    async with transaction() as tx:
        await _lock_route(tx, actor, route.id, list(by_id), ("planned", "active"))
        await tx.routestop.delete_many(where={"routeId": route.id})
        await tx.routestop.create_many(data=[{"routeId": route.id, **s} for s in finished_rows + stops])
        await _assign_stops(tx, route.id, actor["id"], finished_rows + stops)
        route = await tx.route.update(where={"id": route.id}, data=data)
    return await serialize_route(route)


@jobs.handler("optimize_route")
async def _optimize_route_job(payload: dict) -> dict:
    """POST /v2/routes/{id}/optimize, run by the worker: the same as optimize(), then a short summary for the app."""
    actor = {"id": payload["riderId"], "role": "rider", "email": "", "fullName": ""}
    route = await optimize(actor, payload["routeId"], payload.get("origin"))
    return {"routeId": route["id"], "distanceKm": route["distanceKm"], "durationMin": route["durationMin"], "optimization": route["optimization"],
            "stops": len(route["stops"])}


async def _find_mine(actor: dict, route_id: str, client: Any = db) -> Any:
    route = await client.route.find_first(where={"id": route_id, "riderId": actor["id"]})
    if not route:
        raise not_found("Route")
    return route


async def get_by_id(actor: dict, route_id: str) -> dict:
    _require_rider(actor)
    return await serialize_route(await _find_mine(actor, route_id))


async def get_current(actor: dict, date: str | None = None) -> dict | None:
    """The route underway, else the one planned for today (routes planned for later days are "upcoming")."""
    route = await find_current(actor, date)
    return await serialize_route(route) if route else None


async def list_upcoming(actor: dict, date: str | None = None) -> list[dict]:
    """Routes planned for days after `date` (default today), soonest first."""
    _require_rider(actor)
    routes = await db.route.find_many(where={"riderId": actor["id"], "status": "planned", "serviceDate": {"gt": date or today_key()}},
                                      order=[{"serviceDate": "asc"}, {"createdAt": "asc"}])
    return await serialize_routes(routes)


async def list_by_date(actor: dict, date_from: str, date_to: str | None = None, limit: int = 200) -> list[dict]:
    """Every route (planned, active or completed) with a service date from `date_from` to `date_to` (open-ended when
    omitted), soonest first. Summaries only, without the stop list: two queries however many routes there are."""
    _require_rider(actor)
    service_date: dict[str, str] = {"gte": date_from} | ({"lte": date_to} if date_to else {})
    routes = await db.route.find_many(where={"riderId": actor["id"], "serviceDate": service_date},
                                      order=[{"serviceDate": "asc"}, {"createdAt": "asc"}, {"id": "asc"}], take=limit)
    return await route_summaries(routes)


async def route_summaries(routes: list[Any]) -> list[dict]:
    """Routes without their stop lists (counts only): two queries however many routes there are."""
    counts = await _stop_counts([r.id for r in routes])
    items = []
    for route in routes:
        summary = summarize_counts(counts.get(route.id, {}), route)
        done = summary["total"] - summary["pending"]
        items.append({
            "id": route.id, "name": route.name or None, "status": str(route.status), "preference": str(route.preference),
            "serviceDate": route.serviceDate, "distanceKm": route.distanceKm, "durationMin": route.durationMin,
            "startedAt": route.startedAt, "completedAt": route.completedAt,
            "progress": {"total": summary["total"], "done": done, "remaining": summary["total"] - done},
            "summary": summary,
        })
    return items


# Stops still on each route (a stop carried over to another day keeps its row on the old route but belongs to the new one).
_STOP_COUNTS_SQL = """
SELECT s."routeId" AS "routeId", d."status"::text AS "status", count(*)::int AS "n"
FROM "route_stops" AS s JOIN "deliveries" AS d ON d."id" = s."deliveryId" AND d."routeId" = s."routeId"
WHERE s."routeId" IN (SELECT jsonb_array_elements_text($1::jsonb))
GROUP BY 1, 2
"""


async def _stop_counts(route_ids: list[str]) -> dict[str, dict[str, int]]:
    """{route id: {status: stops}} in one query, without loading the stops."""
    out: dict[str, dict[str, int]] = {}
    if route_ids:
        for row in await db.query_raw(_STOP_COUNTS_SQL, json.dumps(route_ids)):
            out.setdefault(row["routeId"], {})[row["status"]] = int(row["n"])
    return out


async def start(actor: dict, route_id: str) -> dict:
    _require_rider(actor)
    async with transaction() as tx:
        # Under the rider's lock two devices cannot both start a route; the partial unique index backs this up.
        await lock_rider(tx, actor["id"])
        route = await _find_mine(actor, route_id, tx)
        if route.status != "active":
            if route.status != "planned":
                raise conflict("This route is already completed", "INVALID_STATE")
            if not await tx.delivery.count(where={"routeId": route.id, "status": "pending"}):
                raise conflict("This route has no pending deliveries. Build a new one.", "ROUTE_STALE")
            if await tx.route.find_first(where={"riderId": actor["id"], "status": "active"}):
                raise conflict("You already have an active route", "ROUTE_ACTIVE")
            try:
                route = await tx.route.update(where={"id": route.id}, data={"status": "active", "startedAt": now()})
            except UniqueViolationError:
                raise conflict("You already have an active route", "ROUTE_ACTIVE") from None
    return await serialize_route(route)


async def on_stop_finished(route_id: str) -> None:
    """Completes the route automatically once no stop is left open."""
    if not await db.delivery.count(where={"routeId": route_id, "status": {"in": list(OPEN)}}):
        await db.route.update_many(where={"id": route_id, "status": "active"}, data={"status": "completed", "completedAt": now()})


async def list_completed(actor: dict, limit: int = 30) -> list[dict]:
    _require_rider(actor)
    routes = await db.route.find_many(where={"riderId": actor["id"], "status": "completed"}, order=[{"completedAt": "desc"}, {"id": "desc"}], take=limit)
    return await serialize_routes(routes)


async def find_current(actor: dict, date: str | None = None) -> Any:
    """The route underway, else the latest one planned for `date` or earlier (get_current's choice, without loading it)."""
    _require_rider(actor)
    return (await db.route.find_first(where={"riderId": actor["id"], "status": "active"})
            or await db.route.find_first(where={"riderId": actor["id"], "status": "planned", "serviceDate": {"lte": date or today_key()}},
                                         order=[{"createdAt": "desc"}, {"id": "desc"}]))


# ---- Open stops left from earlier days ----

def _left_over_where(actor: dict, date: str) -> dict:
    """Open stops dated before `date` that are not already on a route for `date` or later."""
    return {"riderId": actor["id"], "status": {"in": list(OPEN)}, "serviceDate": {"lt": date},
            "OR": [{"routeId": None}, {"route": {"is": {"serviceDate": {"lt": date}}}}]}


async def left_over(actor: dict, date: str) -> dict:
    """How many open stops are left from days before `date` (the rider's today), per day, latest first."""
    _require_rider(actor)
    rows = await db.delivery.group_by(by=["serviceDate"], where=_left_over_where(actor, date), count=True)
    days = {row["serviceDate"]: row["_count"]["_all"] for row in rows}
    return {"total": sum(days.values()), "days": [{"date": k, "count": days[k]} for k in sorted(days, reverse=True)]}


async def carry_over(actor: dict, date: str, origin: dict | None = None) -> dict:
    """Moves every open stop left from earlier days to `date`, as a route of their own (named after the route they
    were on). Other routes of that day are left alone. Nothing is deleted: the old routes are closed (completed, so
    they stay in History with the stops that were done) and keep their stop rows."""
    _require_rider(actor)
    async with transaction() as tx:
        await lock_rider(tx, actor["id"])
        moving = await tx.delivery.find_many(where=_left_over_where(actor, date))
        if not moving:
            return {"moved": 0, "route": None}
        old_route_ids = list({d.routeId for d in moving if d.routeId})
        # An arrived-but-not-delivered stop starts the new day as an ordinary open stop.
        await tx.delivery.update_many(where={"id": {"in": [d.id for d in moving]}},
                                      data={"serviceDate": date, "routeId": None, "stopOrder": None, "status": "pending"})
        old_routes = await tx.route.find_many(where={"id": {"in": old_route_ids}}) if old_route_ids else []
        for route in old_routes:
            if str(route.status) != "completed" and not await tx.delivery.count(where={"routeId": route.id, "status": {"in": list(OPEN)}}):
                await tx.route.update(where={"id": route.id}, data={"status": "completed", "completedAt": now()})

    named = {r.name for r in old_routes if r.name}
    try:
        route = await build(actor, origin=origin, delivery_ids=[d.id for d in moving], date=date,
                            name=named.pop() if len(named) == 1 else "Carried-over stops")
    except AppError:
        # The stops are moved either way; they can be planned from Home once the map lookup is back.
        log(logging.WARNING, "Carried-over stops could not be added to a route", exc_info=True)
        route = None
    return {"moved": len(moving), "route": route}
