from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import Field, StringConstraints, model_validator

from ..auth import authenticate
from ..errors import AppError
from ..http import respond
from ..middleware import geocode_daily_limiter, geocode_limiter, limit, limit_rider, suggest_daily_limiter, suggest_limiter, upload_limiter
from ..services import delivery_service as deliveries
from ..services import geocoding_service as geocoding
from ..services.file_import import build_draft_from_file
from ..services.pdf_import import build_draft
from ..services.route_service import service_area_for
from ..services.serializers import serialize_delivery
from ..uploads import DOCUMENT, PDF, PHOTO, receive
from ..validation import DateKey, IdParams, Pagination, Phone, Schema, Trimmed, validate

router = APIRouter(prefix="/deliveries")

Text = lambda hi: Annotated[str, StringConstraints(strip_whitespace=True, max_length=hi)]
# Customer name and phone are optional: a scanned label often only has the address and parcel ID.
OptionalPhone = Literal[""] | Phone | None
# The parcel ID is optional too: a stop can be just an address. "" means none.
OptionalParcel = Literal[""] | Trimmed(3, 80) | None


class Coordinates(Schema):
    latitude: Annotated[float, Field(ge=-90, le=90)]
    longitude: Annotated[float, Field(ge=-180, le=180)]


class CustomerInput(Schema):
    name: Text(160) | None = None
    phone: OptionalPhone = None


class AddressInput(Schema):
    raw: Trimmed(5, 400)
    # The address the map found for `raw` (with `location`), e.g. the street of a place name the rider typed.
    normalized: Trimmed(1, 400) | None = None


class DeliveryInput(Schema):
    trackingId: OptionalParcel = None
    customer: CustomerInput = Field(default_factory=CustomerInput)
    address: AddressInput
    # Set when the rider picked a suggested address or dropped a pin: the stop is saved already located.
    location: Coordinates | None = None
    note: Text(1000) | None = None
    serviceDate: DateKey | None = None


class BulkBody(Schema):
    items: Annotated[list[DeliveryInput], Field(min_length=1, max_length=300)]


class PatchBody(Schema):
    nullable_fields = frozenset({"note"})
    trackingId: OptionalParcel = None
    customer: CustomerInput | None = None
    address: AddressInput | None = None
    note: Text(1000) | None = None

    @model_validator(mode="after")
    def not_empty(self):
        if not self.model_fields_set:
            raise ValueError("Nothing to update")
        return self


class ListQuery(Pagination):
    status: Literal["pending", "in_progress", "delivered", "failed"] | None = None
    date: DateKey | None = None
    dateFrom: DateKey | None = None
    dateTo: DateKey | None = None
    search: Text(100) | None = None
    sort: Literal["route", "recent"] | None = None


class GeocodeCheckBody(Schema):
    address: Trimmed(5, 400)
    # The rider's GPS position, used to pick their city when they have not confirmed one yet.
    latitude: Annotated[float, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[float, Field(ge=-180, le=180)] | None = None


class GeocodeCheckBatchBody(Schema):
    # As many as one bulk add takes (BulkBody), so a file is checked in the same chunks it is added in.
    addresses: Annotated[list[Trimmed(5, 400)], Field(min_length=1, max_length=300)]
    latitude: Annotated[float, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[float, Field(ge=-180, le=180)] | None = None


# Lookups at the same time for one batch: quick for a file of 200, gentle on the provider's per-second limits.
BATCH_LOOKUPS_AT_ONCE = 6
_NOT_FOUND = {"found": False, "approximate": False, "latitude": None, "longitude": None, "normalized": None, "postalCode": None}


class SuggestBody(Schema):
    query: Trimmed(2, 400)
    latitude: Annotated[float, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[float, Field(ge=-180, le=180)] | None = None


LocationBody = Coordinates


class DeliverBody(Schema):
    note: Text(1000) | None = None
    allowSkip: bool | None = None


class FailBody(Schema):
    reason: Literal["customer_unavailable", "customer_refused", "wrong_address", "phone_unreachable", "business_closed", "other"]
    note: Text(1000) | None = None

    @model_validator(mode="after")
    def describe_other(self):
        if self.reason == "other" and not self.note:
            raise ValueError("Please describe the reason")
        return self


def _item(model: DeliveryInput) -> dict:
    return model.model_dump()


@router.post("/import/pdf")
async def import_pdf(request: Request):
    actor = await authenticate(request, "rider")
    await limit(request, upload_limiter)
    return respond(await build_draft(actor, await receive(request, PDF)))


@router.post("/import/file")
async def import_file(request: Request):
    actor = await authenticate(request, "rider")
    await limit(request, upload_limiter)
    return respond(await build_draft_from_file(actor, await receive(request, DOCUMENT)))


@router.post("/manual")
async def create_manual(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=DeliveryInput))["body"]
    created = await deliveries.create_many(actor, [_item(body)])
    return respond(created[0], 201)


@router.post("/bulk")
async def create_bulk(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=BulkBody))["body"]
    return respond(await deliveries.create_many(actor, [_item(i) for i in body.items]), 201)


@router.post("/geocode-check")
async def geocode_check(request: Request):
    """Looks an address up on the map without saving anything (used by the camera before adding a stop)."""
    actor = await authenticate(request, "rider")
    await limit(request, geocode_limiter)
    await limit_rider(actor, geocode_daily_limiter)
    body = (await validate(request, body=GeocodeCheckBody))["body"]
    origin = {"latitude": body.latitude, "longitude": body.longitude} if body.latitude is not None and body.longitude is not None else None
    area = await service_area_for(actor, origin)
    hit = await geocoding.geocode_address(body.address, area=area)
    if not hit or hit.get("latitude") is None or hit.get("longitude") is None:
        return respond({"found": False, "approximate": False, "latitude": None, "longitude": None, "normalized": None, "postalCode": None})
    return respond({"found": True, "approximate": bool(hit.get("approximate")), "latitude": hit["latitude"],
                    "longitude": hit["longitude"], "normalized": hit.get("normalized"), "postalCode": hit.get("postalCode")})


@router.post("/geocode-check-batch")
async def geocode_check_batch(request: Request):
    """Looks up the addresses of an imported file without saving anything, so the rider can fix the ones the map cannot
    place before they become stops. One request against the per-IP limit; each different address counts once against
    the rider's daily lookups. A lookup the provider fails is reported for that address ("error": true), not for all."""
    actor = await authenticate(request, "rider")
    await limit(request, geocode_limiter)
    body = (await validate(request, body=GeocodeCheckBatchBody))["body"]
    unique = list(dict.fromkeys(body.addresses))
    await limit_rider(actor, geocode_daily_limiter, len(unique))
    origin = {"latitude": body.latitude, "longitude": body.longitude} if body.latitude is not None and body.longitude is not None else None
    area = await service_area_for(actor, origin)
    gate = asyncio.Semaphore(BATCH_LOOKUPS_AT_ONCE)

    async def check(address: str) -> dict:
        async with gate:
            try:
                hit = await geocoding.geocode_address(address, area=area)
            except AppError:
                return {**_NOT_FOUND, "error": True}
        if not hit or hit.get("latitude") is None or hit.get("longitude") is None:
            return {**_NOT_FOUND, "error": False}
        return {"found": True, "approximate": bool(hit.get("approximate")), "latitude": hit["latitude"], "longitude": hit["longitude"],
                "normalized": hit.get("normalized"), "postalCode": hit.get("postalCode"), "error": False}

    found = dict(zip(unique, await asyncio.gather(*(check(address) for address in unique)), strict=True))
    return respond({"results": [found[address] for address in body.addresses]})


@router.post("/geocode-suggest")
async def geocode_suggest(request: Request):
    """Up to 5 matching addresses for what the rider is typing (street, place name or postcode), nearest their city first."""
    actor = await authenticate(request, "rider")
    await limit(request, suggest_limiter)
    await limit_rider(actor, suggest_daily_limiter)
    body = (await validate(request, body=SuggestBody))["body"]
    origin = {"latitude": body.latitude, "longitude": body.longitude} if body.latitude is not None and body.longitude is not None else None
    area = await service_area_for(actor, origin)
    return respond(await geocoding.suggest_addresses(body.query, area=area, near=origin))


@router.post("/geocode-reverse")
async def geocode_reverse(request: Request):
    """The street address at a pin the rider dropped on the map (null when none is known)."""
    actor = await authenticate(request, "rider")
    await limit(request, geocode_limiter)
    await limit_rider(actor, geocode_daily_limiter)
    body = (await validate(request, body=Coordinates))["body"]
    return respond({"address": await geocoding.reverse_geocode(body.latitude, body.longitude)})


@router.get("")
async def list_deliveries(request: Request):
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=ListQuery))["query"]
    items, meta = await deliveries.list_deliveries(actor, query.provided())
    return respond([serialize_delivery(d) for d in items], meta=meta)


@router.delete("")
async def clear_open(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await deliveries.clear_open(actor))


@router.get("/{id}")
async def get_delivery(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(await deliveries.get(actor, params.id))


@router.patch("/{id}")
async def update_delivery(request: Request):
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=PatchBody)
    patch = valid["body"].model_dump(exclude_unset=True)
    return respond(await deliveries.update(actor, valid["params"].id, patch))


@router.post("/{id}/location")
async def set_location(request: Request):
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=LocationBody)
    body = valid["body"]
    return respond(await deliveries.set_location(actor, valid["params"].id, body.latitude, body.longitude))


@router.delete("/{id}")
async def delete_delivery(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    await deliveries.remove(actor, params.id)
    return respond({"deleted": True})


@router.post("/{id}/arrive")
async def arrive(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(await deliveries.arrive(actor, params.id))


@router.post("/{id}/proof")
async def proof(request: Request):
    actor = await authenticate(request, "rider")
    await limit(request, upload_limiter)
    params = (await validate(request, params=IdParams))["params"]
    return respond(await deliveries.attach_proof(actor, params.id, await receive(request, PHOTO)))


@router.post("/{id}/deliver")
async def deliver(request: Request):
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=DeliverBody)
    body = valid["body"]
    return respond(await deliveries.deliver(actor, valid["params"].id, note=body.note, allow_skip=bool(body.allowSkip)))


@router.post("/{id}/fail")
async def fail(request: Request):
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=FailBody)
    body = valid["body"]
    return respond(await deliveries.fail(actor, valid["params"].id, reason=body.reason, note=body.note))
