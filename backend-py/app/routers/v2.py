"""/api/v2: the lean rider API (one request per screen or action, idempotent writes). /api/v1 is unchanged."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import Field, model_validator
from starlette.responses import Response

from ..auth import authenticate
from ..db import db
from ..http import respond, today_key
from ..middleware import geocode_daily_limiter, geocode_limiter, limit, limit_rider, suggest_daily_limiter, suggest_limiter, upload_limiter
from ..services import geocoding_service as geocoding
from ..services import idempotency_service as idempotency
from ..services import jobs
from ..services import v2_service as v2
from ..services.route_service import service_area_for
from ..uploads import PHOTO, receive
from ..validation import DateKey, IdParams, ObjectId, Schema, validate
from .deliveries import Coordinates, DeliveryInput, Text

router = APIRouter()


class DayQuery(Schema):
    # The rider's local date ("today" on the phone's clock).
    date: DateKey | None = None


@router.get("/rider/home")
async def home(request: Request):
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DayQuery))["query"]
    return respond(await v2.home(actor, query.date or today_key()))


def _etag_matches(request: Request, etag: str) -> bool:
    sent = request.headers.get("if-none-match") or ""
    return any(tag.strip().removeprefix("W/") == etag.removeprefix("W/") for tag in sent.split(",")) or sent.strip() == "*"


class CompletedQuery(Schema):
    status: Literal["completed"] = "completed"
    # The `next` of the previous page.
    before: Annotated[str, Field(min_length=10, max_length=80)] | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 30


@router.get("/routes")
async def list_routes(request: Request):
    """Finished routes as summaries (counts, distance, times; no stops), newest first, paged with `before`."""
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=CompletedQuery))["query"]
    return respond(await v2.completed_routes(actor, query.before, query.limit))


@router.get("/routes/current")
async def current_route(request: Request):
    """The route underway, else the latest one planned for `date` (default today) or earlier, light; null when none."""
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DayQuery))["query"]
    return respond(await v2.current_route(actor, query.date or today_key()))


@router.get("/routes/{id}")
async def get_route(request: Request):
    """The route with all its stops (light). Send If-None-Match with the last ETag: 304 and no body when nothing changed."""
    actor = await authenticate(request, "rider")
    route_id = (await validate(request, params=IdParams))["params"].id
    etag = await v2.route_etag(actor, route_id)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request, etag):
        return Response(status_code=304, headers=headers)
    return respond(await v2.get_route(actor, route_id), headers=headers)


class ChangesQuery(Schema):
    since: Annotated[str, Field(min_length=10, max_length=40)]


@router.get("/routes/{id}/changes")
async def route_changes(request: Request):
    """Stops changed since `since` (the `cursor` of the previous answer), the route's progress and the next cursor."""
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, query=ChangesQuery)
    return respond(await v2.route_changes(actor, valid["params"].id, v2.parse_cursor(valid["query"].since)))


class EventBody(Schema):
    type: Literal["arrive", "deliver", "fail"]
    reason: Literal["customer_unavailable", "customer_refused", "wrong_address", "phone_unreachable", "business_closed", "other"] | None = None
    note: Text(1000) | None = None
    # deliver: also when earlier stops are still open (the rider confirmed).
    allowSkip: bool | None = None
    # When it happened on the phone (ISO 8601). Offline phones send events late; the newest event per stop wins.
    at: datetime | None = None

    @model_validator(mode="after")
    def fail_needs_reason(self):
        if self.type == "fail" and not self.reason:
            raise ValueError("reason: Required when type is fail")
        if self.type == "fail" and self.reason == "other" and not self.note:
            raise ValueError("note: Describe what happened when the reason is other")
        return self


@router.post("/stops/{id}/events")
async def stop_event(request: Request):
    """arrive / deliver / fail. Needs an Idempotency-Key; returns the stop and the route's progress."""
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=EventBody)
    stop_id, body = valid["params"].id, valid["body"]

    async def action():
        return 200, {"success": True, "data": await v2.stop_event(actor, stop_id, body.type, reason=body.reason, note=body.note,
                                                                   allow_skip=bool(body.allowSkip), at=body.at,
                                                                   idempotency_key=request.headers.get(idempotency.KEY_HEADER))}

    return await idempotency.run(request, actor, "POST /v2/stops/{id}/events",
                                 idempotency.request_hash(stop_id, body.model_dump(exclude_none=True)), action)


class BatchItem(DeliveryInput):
    # A UUID the app made for this stop: sending the same one again returns the stop instead of adding another.
    clientId: Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    # The rider confirmed another parcel for an Eircode already on that day (else 409 SAME_EIRCODE_SAME_DAY).
    secondParcel: bool | None = None


class BatchBody(Schema):
    items: Annotated[list[BatchItem], Field(min_length=1, max_length=500)]


@router.post("/deliveries/batch")
async def create_batch(request: Request):
    """Up to 500 stops at once, each with the app's own clientId. Safe to resend: known clientIds are not added twice."""
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=BatchBody))["body"]
    status, data = await v2.create_batch(actor, [{**i.model_dump(), "clientId": i.clientId.lower()} for i in body.items])
    return respond(data, status)


class ProofQuery(Schema):
    stopId: ObjectId


@router.post("/uploads/proof")
async def upload_proof(request: Request):
    """multipart/form-data with one `photo` (JPEG/PNG) for ?stopId=. Needs an Idempotency-Key. Accepted while the stop is
    being delivered or after it was delivered."""
    actor = await authenticate(request, "rider")
    await limit(request, upload_limiter)
    stop_id = (await validate(request, query=ProofQuery))["query"].stopId
    idempotency.key_from(request)  # refuse before reading a large body
    photo = await receive(request, PHOTO)

    async def action():
        return 200, {"success": True, "data": await v2.upload_proof(actor, stop_id, photo)}

    return await idempotency.run(request, actor, "POST /v2/uploads/proof", idempotency.request_hash(stop_id, photo.data if photo else b""), action)


# ---------- Address search: Places Autocomplete (New) + Place Details, one billing session per address (P5.1) ----------

# A UUID the app makes when the rider starts typing an address, sent with every keystroke's request and with the pick.
SessionToken = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")]


class AutocompleteBody(Schema):
    input: Annotated[str, Field(min_length=1, max_length=200)]
    sessionToken: SessionToken
    # Where the rider is (riders without a saved city still get nearby results first).
    latitude: Annotated[float, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[float, Field(ge=-180, le=180)] | None = None


@router.post("/places/autocomplete")
async def places_autocomplete(request: Request):
    """Up to 5 suggestions for what the rider is typing: {placeId, label, latitude, longitude, approximate}. With Google
    the point is not included (placeId set): POST /v2/places/details with the same sessionToken when the rider picks."""
    actor = await authenticate(request, "rider")
    await limit(request, suggest_limiter)
    await limit_rider(actor, suggest_daily_limiter)
    body = (await validate(request, body=AutocompleteBody))["body"]
    near = {"latitude": body.latitude, "longitude": body.longitude} if body.latitude is not None and body.longitude is not None else None
    area = await service_area_for(actor, near)
    return respond({"suggestions": await geocoding.autocomplete(body.input.strip(), session_token=body.sessionToken, area=area, near=near)})


class DetailsBody(Schema):
    placeId: Annotated[str, Field(min_length=1, max_length=300, pattern=r"^[A-Za-z0-9_-]+$")]
    sessionToken: SessionToken | None = None


@router.post("/places/details")
async def places_details(request: Request):
    """The point of a picked suggestion (ends the billing session): {found, latitude, longitude, normalized, postalCode, approximate}."""
    actor = await authenticate(request, "rider")
    await limit(request, geocode_limiter)
    await limit_rider(actor, geocode_daily_limiter)
    body = (await validate(request, body=DetailsBody))["body"]
    hit = await geocoding.place_details(body.placeId, session_token=body.sessionToken, area=await service_area_for(actor, None))
    if not hit:
        return respond({"found": False, "latitude": None, "longitude": None, "normalized": None, "postalCode": None, "approximate": False})
    return respond({"found": True, "latitude": hit["latitude"], "longitude": hit["longitude"], "normalized": hit.get("normalized"),
                    "postalCode": hit.get("postalCode"), "approximate": bool(hit.get("approximate"))})


# ---------- Route optimisation as a background job (P6b.2) ----------

class OptimizeBody(Schema):
    # Where the rider is now: the open stops are ordered from here (default: the route's start).
    origin: Coordinates | None = None


@router.post("/routes/{id}/optimize")
async def optimize_route(request: Request):
    """Queues a re-optimisation of the route's open stops (the worker does it, VROOM or the built-in planner) and answers
    202 with the job at once; poll GET /v2/jobs/{id}. A second request while one is waiting returns that job."""
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=OptimizeBody)
    route_id = valid["params"].id
    await v2.route_etag(actor, route_id)  # 404 unless it is this rider's route
    waiting = await db.job.find_first(where={"routeId": route_id, "type": "optimize_route", "status": {"in": ["queued", "running"]}})
    if waiting:
        return respond(jobs.serialize(waiting))
    job = await jobs.enqueue("optimize_route", {"riderId": actor["id"], "routeId": route_id,
                                                "origin": valid["body"].origin.model_dump() if valid["body"].origin else None},
                             rider_id=actor["id"], route_id=route_id)
    return respond(jobs.serialize(job), 202)


@router.get("/jobs/{id}")
async def get_job(request: Request):
    """A background job of this rider: status queued | running | done | failed, and its result (or error)."""
    actor = await authenticate(request, "rider")
    return respond(await jobs.get_for(actor, (await validate(request, params=IdParams))["params"].id))


@router.get("/routes/{id}/geometry")
async def route_geometry(request: Request):
    """The route's road line (encoded polyline, precision 5) and each open stop's leg, from our OSRM; cached per route
    version. ETag/304 like the route itself. path is null when no road router is configured."""
    actor = await authenticate(request, "rider")
    route_id = (await validate(request, params=IdParams))["params"].id
    version, data = await v2.route_geometry(actor, route_id)
    headers = {"ETag": version, "Cache-Control": "private, no-cache"}
    if _etag_matches(request, version):
        return Response(status_code=304, headers=headers)
    return respond(data, headers=headers)


class NavigationBody(Schema):
    start: Coordinates
    target: Coordinates


@router.post("/navigation/route")
async def navigation_route(request: Request):
    """Re-route for live navigation (P6b.5): our OSRM's road path and turn steps from the rider to the next stop."""
    await authenticate(request, "rider")
    body = (await validate(request, body=NavigationBody))["body"]
    return respond(await v2.navigation_route(body.start.model_dump(), body.target.model_dump()))
