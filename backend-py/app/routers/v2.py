"""/api/v2: the lean rider API (one request per screen or action, idempotent writes). /api/v1 is unchanged."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import Field, model_validator
from starlette.responses import Response

from ..auth import authenticate
from ..http import respond, today_key
from ..middleware import limit, upload_limiter
from ..services import idempotency_service as idempotency
from ..services import v2_service as v2
from ..uploads import PHOTO, receive
from ..validation import DateKey, IdParams, ObjectId, Schema, validate
from .deliveries import DeliveryInput, Text

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
