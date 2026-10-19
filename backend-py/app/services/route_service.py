from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from ..db import db, lock_rider, transaction
from ..errors import AppError, conflict, forbidden, not_found, unprocessable
from ..http import js_round, now, round2, today_key
from ..ids import new_id
from ..logger import log
from . import geocoding_service as geocoding
from . import routing_service
from .geo import haversine_km, normalize_address
from .route_planner import START, plan_route
from .serializers import clean_delivery_address, serialize_delivery
from .settings_service import get_settings

OPEN = ("pending", "in_progress")
ROUTE_ROAD_FACTOR = 1.3
_FRESH_ADDRESS = {"addressNormalized": None, "addressLatitude": None, "addressLongitude": None, "addressGeocoded": False,
                  "addressApproximate": False, "geocodeStatus": "pending"}


def summarize(deliveries: list[Any], route: Any = None) -> dict:
    statuses = [str(d.status) for d in deliveries]
    minutes = None
    if route is not None and route.startedAt and route.completedAt:
        minutes = max(1, js_round((route.completedAt - route.startedAt).total_seconds() / 60))
    return {
        "total": len(statuses),
        "delivered": statuses.count("delivered"),
        "failed": statuses.count("failed"),
        "pending": sum(1 for s in statuses if s in OPEN),
        "distanceKm": route.distanceKm if route is not None and route.distanceKm is not None else 0,
        "routeMinutes": minutes,
    }


def _origin(route: Any) -> Optional[dict]:
    if route.originLatitude is None:
        return None
    return {"latitude": route.originLatitude, "longitude": route.originLongitude}


async def serialize_route(route: Any) -> dict:
    stop_rows = sorted(await db.routestop.find_many(where={"routeId": route.id}), key=lambda s: s.order)
    # A stop carried over to another day keeps its row here for the record, but belongs to its new route now.
    deliveries = await db.delivery.find_many(where={"id": {"in": [s.deliveryId for s in stop_rows]}, "routeId": route.id}) if stop_rows else []
    by_id = {d.id: d for d in deliveries}
    stops = [
        {"order": i + 1, "legDistanceKm": s.legDistanceKm, "legDurationMin": s.legDurationMin, "delivery": serialize_delivery(by_id[s.deliveryId])}
        for i, s in enumerate(s for s in stop_rows if s.deliveryId in by_id)
    ]
    done = sum(1 for s in stops if s["delivery"]["status"] not in OPEN)
    current = next((s for s in stops if s["delivery"]["status"] in OPEN), None)
    # Stops added after the route was planned; the app offers to re-optimise to include them.
    new_stops = 0 if str(route.status) == "completed" else await db.delivery.count(
        where={"riderId": route.riderId, "status": "pending", "routeId": None, "serviceDate": route.serviceDate})
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


async def _release_planned(actor: dict, date: str) -> None:
    """Replanning a day replaces that day's unstarted route; routes planned for other days stay."""
    planned = await db.route.find_many(where={"riderId": actor["id"], "status": "planned", "serviceDate": date})
    if not planned:
        return
    ids = [r.id for r in planned]
    await db.delivery.update_many(where={"routeId": {"in": ids}, "status": "pending"}, data={"routeId": None, "stopOrder": None})
    await db.route.delete_many(where={"id": {"in": ids}})


def area_of_user(user: Any) -> Optional[dict]:
    if not user or not user.areaCity or not user.areaCountryCode:
        return None
    return {"city": user.areaCity, "country": user.areaCountry, "countryCode": user.areaCountryCode, "latitude": user.areaLatitude,
            "longitude": user.areaLongitude, "source": str(user.areaSource) if user.areaSource else None, "confirmedAt": user.areaConfirmedAt}


async def service_area_for(actor: dict, origin: Optional[dict]) -> Optional[dict]:
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


async def _refresh_delivery_geocodes(deliveries: list[Any], *, retry_approximate: bool = False, area: Optional[dict] = None) -> list[Any]:
    """Looks up stops without coordinates. Returns the deliveries as saved (same order)."""
    from .delivery_service import save_delivery

    out = list(deliveries)
    for i, d in enumerate(out):
        clean = clean_delivery_address(d.addressRaw, d.payment)
        if clean != d.addressRaw:
            out[i] = await save_delivery(d, {"addressRaw": clean, **_FRESH_ADDRESS})

    # On a retry, also redo "found" stops that sit outside the rider's city (e.g. matched abroad before areas existed).
    def outside_area(d: Any) -> bool:
        point = {"latitude": d.addressLatitude, "longitude": d.addressLongitude}
        return bool(retry_approximate and area and d.geocodeStatus == "found" and not geocoding.is_inside_area(point, area))

    todo = [i for i, d in enumerate(out)
            if outside_area(d) or (d.geocodeStatus != "found" and (retry_approximate or d.geocodeStatus != "approximate"))]
    if not todo:
        return out

    results = await geocoding.geocode_many([out[i].addressRaw for i in todo],
                                           retry_approximate=retry_approximate or any(outside_area(out[i]) for i in todo), area=area)
    for i in todo:
        d = out[i]
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
        out[i] = await save_delivery(d, data)
    return out


async def _plan(deliveries: list[Any], origin: Optional[dict], preference: str, settings: dict, first_order: int = 1) -> tuple[list[dict], float, float, str]:
    """Orders the stops. Only verified locations are optimised; unresolved (or approximate) ones go last.
    Returns (stops, distanceKm, durationMin, optimization) where optimization is "road" or "straight_line"."""
    located = [d for d in deliveries if d.addressGeocoded]
    unlocated = [d for d in deliveries if not d.addressGeocoded]
    points = ([origin] if origin else []) + [{"latitude": d.addressLatitude, "longitude": d.addressLongitude} for d in located]
    ids = ([START] if origin else []) + [d.id for d in located]
    matrix = await routing_service.road_matrix(ids, points) if located else None
    # Ordering is CPU work (up to an exact search), so it runs off the event loop.
    plan = await asyncio.to_thread(
        plan_route,
        origin=origin, preference=preference, avg_speed_kmh=settings["route"]["avgSpeedKmh"], service_minutes=settings["route"]["stopServiceMinutes"],
        stops=[{"id": d.id, "latitude": d.addressLatitude, "longitude": d.addressLongitude, "addressKey": normalize_address(d.addressRaw)} for d in located],
        matrix=matrix,
    )
    stops = [
        *({"deliveryId": did, "order": first_order + i, "legDistanceKm": plan["legs"][i]["distanceKm"], "legDurationMin": plan["legs"][i]["durationMin"]}
          for i, did in enumerate(plan["order"])),
        *({"deliveryId": d.id, "order": first_order + len(plan["order"]) + i, "legDistanceKm": 0, "legDurationMin": 0} for i, d in enumerate(unlocated)),
    ]
    return (stops, plan["distanceKm"], plan["durationMin"] + len(unlocated) * settings["route"]["stopServiceMinutes"],
            "road" if matrix else "straight_line")



async def _assign_stops(route_id: str, rider_id: str, stops: list[dict]) -> None:
    async with db.batch_() as batch:
        for s in stops:
            batch.delivery.update_many(where={"id": s["deliveryId"], "riderId": rider_id}, data={"routeId": route_id, "stopOrder": s["order"]})


async def build(actor: dict, *, preference: Optional[str] = None, origin: Optional[dict] = None, delivery_ids: Optional[list[str]] = None,
                date: Optional[str] = None, name: Optional[str] = None) -> dict:
    _require_rider(actor)
    date = date or today_key()
    active = await db.route.find_first(where={"riderId": actor["id"], "status": "active"})
    # A route for a later day can be planned while today's is underway (e.g. tomorrow's, the night before).
    if active and active.serviceDate >= date:
        raise conflict("Finish or end your active route before planning a new one", "ROUTE_ACTIVE")
    await _release_planned(actor, date)

    where: dict[str, Any] = {"riderId": actor["id"], "status": "pending", "routeId": None}
    if delivery_ids:
        where["id"] = {"in": delivery_ids}
    else:
        # The day's open stops (and older ones still open), never stops already added for a later day.
        where["serviceDate"] = {"lte": date}
    deliveries = await db.delivery.find_many(where=where, order=[{"createdAt": "asc"}, {"id": "asc"}])
    if not deliveries:
        raise unprocessable("Add deliveries before building a route", "NO_DELIVERIES")

    settings, user = await asyncio.gather(get_settings(), db.user.find_unique(where={"id": actor["id"]}))
    pref = preference or (str(user.routePreference) if user else None) or settings["route"]["defaultPreference"]

    # Geocode before ordering so stop numbers reflect destination order, not entry order.
    deliveries = await _refresh_delivery_geocodes(deliveries, area=await service_area_for(actor, origin))
    stops, distance_km, duration_min, optimization = await _plan(deliveries, origin, pref, settings)

    route = await db.route.create(data={
        "id": new_id(), "riderId": actor["id"], "serviceDate": date, "name": name or None, "preference": pref,
        "status": "planned", "originLatitude": origin["latitude"] if origin else None, "originLongitude": origin["longitude"] if origin else None,
        "distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization,
    })
    await db.routestop.create_many(data=[{"routeId": route.id, **s} for s in stops])
    await _assign_stops(route.id, actor["id"], stops)
    return await serialize_route(route)


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
        await db.routestop.delete_many(where={"routeId": route.id})
        await db.routestop.create_many(data=[{"routeId": route.id, **s} for s in stops])
        route = await db.route.update(where={"id": route.id}, data={"distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization})
        await _assign_stops(route.id, actor["id"], stops)
    else:
        previous = origin
        distance_km = 0.0
        travel = 0
        async with db.batch_() as batch:
            for stop in sorted(stop_rows, key=lambda s: s.order):
                d = by_id.get(stop.deliveryId)
                if not d or not d.addressGeocoded:
                    previous = None
                    continue
                point = {"latitude": d.addressLatitude, "longitude": d.addressLongitude}
                distance = round2(haversine_km(previous, point) * ROUTE_ROAD_FACTOR) if previous else 0
                minutes = js_round((distance / settings["route"]["avgSpeedKmh"]) * 60)
                batch.routestop.update(where={"routeId_deliveryId": {"routeId": route.id, "deliveryId": stop.deliveryId}},
                                       data={"legDistanceKm": distance, "legDurationMin": minutes})
                distance_km += distance
                travel += minutes
                previous = point
        route = await db.route.update(where={"id": route.id}, data={
            "distanceKm": round2(distance_km), "durationMin": travel + len(stop_rows) * settings["route"]["stopServiceMinutes"],
        })
    return await serialize_route(route)


async def optimize(actor: dict, route_id: str, origin: Optional[dict] = None) -> dict:
    """Re-optimises the open stops of a planned or active route from `origin` (the rider's position;
    defaults to the route's start). Pulls in stops added since planning; finished stops keep their place."""
    _require_rider(actor)
    route = await _find_mine(actor, route_id)
    if route.status not in ("planned", "active"):
        raise conflict("Only planned or active routes can be optimised", "INVALID_STATE")
    stop_rows = sorted(await db.routestop.find_many(where={"routeId": route.id}), key=lambda s: s.order)
    on_route = await db.delivery.find_many(where={"riderId": actor["id"], "routeId": route.id, "id": {"in": [s.deliveryId for s in stop_rows]}})
    added = await db.delivery.find_many(where={"riderId": actor["id"], "status": "pending", "routeId": None, "serviceDate": route.serviceDate},
                                        order=[{"createdAt": "asc"}, {"id": "asc"}])
    by_id = {d.id: d for d in on_route}
    finished = [by_id[s.deliveryId] for s in stop_rows if s.deliveryId in by_id and str(by_id[s.deliveryId].status) not in OPEN]
    open_stops = [by_id[s.deliveryId] for s in stop_rows if s.deliveryId in by_id and str(by_id[s.deliveryId].status) in OPEN] + added
    start_point = origin or _origin(route)

    open_stops = await _refresh_delivery_geocodes(open_stops, area=await service_area_for(actor, start_point))
    settings, user = await asyncio.gather(get_settings(), db.user.find_unique(where={"id": actor["id"]}))
    pref = str(route.preference) or (str(user.routePreference) if user else None) or settings["route"]["defaultPreference"]
    stops, distance_km, duration_min, optimization = await _plan(open_stops, start_point, pref, settings, first_order=len(finished) + 1)

    keep = {s.deliveryId: s for s in stop_rows}
    finished_rows = [{"deliveryId": d.id, "order": i + 1, "legDistanceKm": keep[d.id].legDistanceKm, "legDurationMin": keep[d.id].legDurationMin}
                     for i, d in enumerate(finished)]
    await db.routestop.delete_many(where={"routeId": route.id})
    await db.routestop.create_many(data=[{"routeId": route.id, **s} for s in finished_rows + stops])
    await _assign_stops(route.id, actor["id"], finished_rows + stops)
    data: dict[str, Any] = {"distanceKm": distance_km, "durationMin": duration_min, "optimization": optimization}
    if origin:
        data |= {"originLatitude": origin["latitude"], "originLongitude": origin["longitude"]}
    route = await db.route.update(where={"id": route.id}, data=data)
    return await serialize_route(route)


async def _find_mine(actor: dict, route_id: str) -> Any:
    route = await db.route.find_first(where={"id": route_id, "riderId": actor["id"]})
    if not route:
        raise not_found("Route")
    return route


async def get_by_id(actor: dict, route_id: str) -> dict:
    _require_rider(actor)
    return await serialize_route(await _find_mine(actor, route_id))


async def get_current(actor: dict, date: Optional[str] = None) -> Optional[dict]:
    """The route underway, else the one planned for today (routes planned for later days are "upcoming")."""
    _require_rider(actor)
    route = (await db.route.find_first(where={"riderId": actor["id"], "status": "active"})
             or await db.route.find_first(where={"riderId": actor["id"], "status": "planned", "serviceDate": {"lte": date or today_key()}},
                                          order=[{"createdAt": "desc"}, {"id": "desc"}]))
    return await serialize_route(route) if route else None


async def list_upcoming(actor: dict, date: Optional[str] = None) -> list[dict]:
    """Routes planned for days after `date` (default today), soonest first."""
    _require_rider(actor)
    routes = await db.route.find_many(where={"riderId": actor["id"], "status": "planned", "serviceDate": {"gt": date or today_key()}},
                                      order=[{"serviceDate": "asc"}, {"createdAt": "asc"}])
    return [await serialize_route(r) for r in routes]


async def list_by_date(actor: dict, date_from: str, date_to: Optional[str] = None, limit: int = 200) -> list[dict]:
    """Every route (planned, active or completed) with a service date from `date_from` to `date_to` (open-ended when
    omitted), soonest first. Summaries only, without the stop list: two queries however many routes there are."""
    _require_rider(actor)
    service_date: dict[str, str] = {"gte": date_from} | ({"lte": date_to} if date_to else {})
    routes = await db.route.find_many(where={"riderId": actor["id"], "serviceDate": service_date}, include={"stops": True},
                                      order=[{"serviceDate": "asc"}, {"createdAt": "asc"}, {"id": "asc"}], take=limit)
    ids = [s.deliveryId for r in routes for s in r.stops or []]
    by_id = {d.id: d for d in await db.delivery.find_many(where={"id": {"in": ids}})} if ids else {}
    items = []
    for route in routes:
        on_route = [by_id[s.deliveryId] for s in route.stops or [] if s.deliveryId in by_id and by_id[s.deliveryId].routeId == route.id]
        done = sum(1 for d in on_route if str(d.status) not in OPEN)
        items.append({
            "id": route.id, "name": route.name or None, "status": str(route.status), "preference": str(route.preference),
            "serviceDate": route.serviceDate, "distanceKm": route.distanceKm, "durationMin": route.durationMin,
            "startedAt": route.startedAt, "completedAt": route.completedAt,
            "progress": {"total": len(on_route), "done": done, "remaining": len(on_route) - done},
            "summary": summarize(on_route, route),
        })
    return items


async def start(actor: dict, route_id: str) -> dict:
    _require_rider(actor)
    route = await _find_mine(actor, route_id)
    if route.status == "active":
        return await serialize_route(route)
    if route.status != "planned":
        raise conflict("This route is already completed", "INVALID_STATE")
    if not await db.delivery.count(where={"routeId": route.id, "status": "pending"}):
        raise conflict("This route has no pending deliveries. Build a new one.", "ROUTE_STALE")
    if await db.route.find_first(where={"riderId": actor["id"], "status": "active"}):
        raise conflict("You already have an active route", "ROUTE_ACTIVE")
    route = await db.route.update(where={"id": route.id}, data={"status": "active", "startedAt": now()})
    return await serialize_route(route)


async def on_stop_finished(route_id: str) -> None:
    """Completes the route automatically once no stop is left open."""
    if not await db.delivery.count(where={"routeId": route_id, "status": {"in": list(OPEN)}}):
        await db.route.update_many(where={"id": route_id, "status": "active"}, data={"status": "completed", "completedAt": now()})


async def list_completed(actor: dict, limit: int = 30) -> list[dict]:
    _require_rider(actor)
    routes = await db.route.find_many(where={"riderId": actor["id"], "status": "completed"}, order=[{"completedAt": "desc"}, {"id": "desc"}], take=limit)
    return [await serialize_route(r) for r in routes]


# ---- Open stops left from earlier days ----

def _left_over_where(actor: dict, date: str) -> dict:
    """Open stops dated before `date` that are not already on a route for `date` or later."""
    return {"riderId": actor["id"], "status": {"in": list(OPEN)}, "serviceDate": {"lt": date},
            "OR": [{"routeId": None}, {"route": {"is": {"serviceDate": {"lt": date}}}}]}


async def left_over(actor: dict, date: str) -> dict:
    """How many open stops are left from days before `date` (the rider's today), per day, latest first."""
    _require_rider(actor)
    rows = await db.delivery.find_many(where=_left_over_where(actor, date))
    days: dict[str, int] = {}
    for d in rows:
        days[d.serviceDate] = days.get(d.serviceDate, 0) + 1
    return {"total": len(rows), "days": [{"date": k, "count": days[k]} for k in sorted(days, reverse=True)]}


async def carry_over(actor: dict, date: str, origin: Optional[dict] = None) -> dict:
    """Moves every open stop left from earlier days to `date` and onto that day's route. Nothing is deleted: the old
    routes are closed (completed, so they stay in History with the stops that were done) and keep their stop rows."""
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
    target = (await db.route.find_first(where={"riderId": actor["id"], "status": "active", "serviceDate": date})
              or await db.route.find_first(where={"riderId": actor["id"], "status": "planned", "serviceDate": date},
                                           order=[{"createdAt": "desc"}, {"id": "desc"}]))
    try:
        if target:
            # Re-planning pulls in the day's open stops that are on no route yet, i.e. the ones just moved.
            route = await optimize(actor, target.id, origin=origin)
        else:
            route = await build(actor, origin=origin, delivery_ids=[d.id for d in moving], date=date,
                                name=named.pop() if len(named) == 1 else "Carried-over stops")
    except AppError:
        # The stops are moved either way; they can be planned from Home once the map lookup is back.
        log(logging.WARNING, "Carried-over stops could not be added to a route", exc_info=True)
        route = None
    return {"moved": len(moving), "route": route}
