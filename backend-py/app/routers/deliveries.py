from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from fastapi import APIRouter, Request
from pydantic import Field, StringConstraints, model_validator

from ..auth import authenticate
from ..http import respond
from ..middleware import limit, upload_limiter
from ..services import delivery_service as deliveries
from ..services.file_import import build_draft_from_file
from ..services.pdf_import import build_draft
from ..services.serializers import serialize_delivery
from ..uploads import DOCUMENT, PDF, PHOTO, receive
from ..validation import DateKey, IdParams, Pagination, Phone, Schema, Trimmed, validate

router = APIRouter(prefix="/deliveries")

Text = lambda hi: Annotated[str, StringConstraints(strip_whitespace=True, max_length=hi)]  # noqa: E731
# Customer name and phone are optional: a scanned label often only has the address and parcel ID.
OptionalPhone = Optional[Union[Literal[""], Phone]]


class CustomerInput(Schema):
    name: Optional[Text(160)] = None
    phone: OptionalPhone = None


class AddressInput(Schema):
    raw: Trimmed(5, 400)


class DeliveryInput(Schema):
    trackingId: Trimmed(3, 80)
    customer: CustomerInput = Field(default_factory=CustomerInput)
    address: AddressInput
    note: Optional[Text(1000)] = None
    serviceDate: Optional[DateKey] = None


class BulkBody(Schema):
    items: Annotated[list[DeliveryInput], Field(min_length=1, max_length=300)]


class PatchBody(Schema):
    nullable_fields = frozenset({"note"})
    trackingId: Optional[Trimmed(3, 80)] = None
    customer: Optional[CustomerInput] = None
    address: Optional[AddressInput] = None
    note: Optional[Text(1000)] = None

    @model_validator(mode="after")
    def not_empty(self):
        if not self.model_fields_set:
            raise ValueError("Nothing to update")
        return self


class ListQuery(Pagination):
    status: Optional[Literal["pending", "in_progress", "delivered", "failed"]] = None
    date: Optional[DateKey] = None
    dateFrom: Optional[DateKey] = None
    dateTo: Optional[DateKey] = None
    search: Optional[Text(100)] = None
    sort: Optional[Literal["route", "recent"]] = None


class DeliverBody(Schema):
    note: Optional[Text(1000)] = None
    allowSkip: Optional[bool] = None


class FailBody(Schema):
    reason: Literal["customer_unavailable", "customer_refused", "wrong_address", "phone_unreachable", "business_closed", "other"]
    note: Optional[Text(1000)] = None

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
    limit(request, upload_limiter)
    return respond(await build_draft(actor, await receive(request, PDF)))


@router.post("/import/file")
async def import_file(request: Request):
    actor = await authenticate(request, "rider")
    limit(request, upload_limiter)
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
    limit(request, upload_limiter)
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
