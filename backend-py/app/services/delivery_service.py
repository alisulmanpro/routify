from __future__ import annotations

from typing import Any, Optional

from ..db import db
from ..errors import conflict, forbidden, not_found
from ..http import now, page_meta, paginate, today_key
from ..ids import new_id
from ..uploads import UploadedFile, detect_file_type
from . import storage_service as storage
from .geo import normalize_address
from .route_service import on_stop_finished
from .serializers import serialize_delivery
from .subscription_service import assert_can_create_deliveries

FRESH_ADDRESS = {"addressNormalized": None, "addressLatitude": None, "addressLongitude": None, "addressGeocoded": False,
                 "addressApproximate": False, "geocodeStatus": "pending"}


async def save_delivery(d: Any, data: dict) -> Any:
    """Optimistic concurrency: the write only lands if nobody else saved this delivery since we read it."""
    count = await db.delivery.update_many(where={"id": d.id, "version": d.version}, data={**data, "version": {"increment": 1}})
    if not count:
        raise conflict("This record was changed by someone else. Refresh and try again.")
    return await db.delivery.find_unique(where={"id": d.id})


def _to_row(actor: dict, item: dict) -> dict:
    customer = item.get("customer") or {}
    row = {
        "id": new_id(), "riderId": actor["id"], "trackingId": item["trackingId"],
        "customerName": customer.get("name") or "", "customerPhone": customer.get("phone") or "",
        "addressRaw": item["address"]["raw"], **FRESH_ADDRESS, "serviceDate": item.get("serviceDate") or today_key(),
    }
    if item.get("note"):
        row["note"] = item["note"]
    return row


async def create_many(actor: dict, items: list[dict]) -> list[dict]:
    if actor["role"] != "rider":
        raise forbidden("Only riders create deliveries")
    await assert_can_create_deliveries(actor, len(items))

    ids = [i["trackingId"] for i in items]
    existing = {d.trackingId for d in await db.delivery.find_many(where={"riderId": actor["id"], "trackingId": {"in": ids}})}
    in_batch: set[str] = set()
    details = []
    for index, item in enumerate(items):
        tid = item["trackingId"]
        if tid in existing:
            details.append({"index": index, "path": "trackingId", "code": "DUPLICATE", "message": f"Parcel ID {tid} already exists"})
        elif tid in in_batch:
            details.append({"index": index, "path": "trackingId", "code": "DUPLICATE", "message": f"Parcel ID {tid} appears more than once"})
        in_batch.add(tid)
    if details:
        raise conflict("Some deliveries are duplicates", "DUPLICATE_TRACKING_ID", details)

    rows = [_to_row(actor, item) for item in items]
    await db.delivery.create_many(data=rows)
    created = {d.id: d for d in await db.delivery.find_many(where={"id": {"in": [r["id"] for r in rows]}})}
    return [serialize_delivery(created[r["id"]]) for r in rows]


async def find_visible(actor: dict, delivery_id: str) -> Any:
    where = {"id": delivery_id, "riderId": actor["id"]} if actor["role"] == "rider" else {"id": delivery_id}
    delivery = await db.delivery.find_first(where=where)
    if not delivery:
        raise not_found("Delivery")
    return delivery


async def get(actor: dict, delivery_id: str) -> dict:
    return serialize_delivery(await find_visible(actor, delivery_id))


async def list_deliveries(actor: dict, q: dict) -> tuple[list[Any], dict]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {}
    if actor["role"] == "rider":
        where["riderId"] = actor["id"]
    elif q.get("riderId"):
        where["riderId"] = q["riderId"]
    if q.get("status"):
        where["status"] = q["status"]
    if q.get("date"):
        where["serviceDate"] = q["date"]
    if q.get("dateFrom") or q.get("dateTo"):
        where["serviceDate"] = {**({"gte": q["dateFrom"]} if q.get("dateFrom") else {}), **({"lte": q["dateTo"]} if q.get("dateTo") else {})}
    if q.get("search"):
        rx = {"contains": q["search"], "mode": "insensitive"}
        where["OR"] = [{"trackingId": rx}, {"customerName": rx}, {"addressRaw": rx}]

    total = await db.delivery.count(where=where)
    if q.get("sort") == "route":
        items = await _route_ordered_page(where, skip, limit)
    else:
        items = await db.delivery.find_many(where=where, order=[{"createdAt": "desc"}, {"id": "desc"}], skip=skip, take=limit)
    return items, page_meta(page, limit, total)


async def _route_ordered_page(where: dict, skip: int, take: int) -> list[Any]:
    """Route order with unrouted deliveries (no stop number) first, matching MongoDB's null ordering."""
    unrouted_where = {"AND": [where, {"stopOrder": None}]}
    routed_where = {"AND": [where, {"NOT": [{"stopOrder": None}]}]}
    unrouted = await db.delivery.count(where=unrouted_where)
    items: list[Any] = []
    if skip < unrouted:
        items = await db.delivery.find_many(where=unrouted_where, order=[{"createdAt": "asc"}, {"id": "asc"}], skip=skip, take=take)
    if len(items) < take:
        items += await db.delivery.find_many(where=routed_where, order=[{"stopOrder": "asc"}, {"createdAt": "asc"}, {"id": "asc"}],
                                             skip=max(0, skip - unrouted), take=take - len(items))
    return items


async def update(actor: dict, delivery_id: str, patch: dict) -> dict:
    if actor["role"] != "rider":
        raise forbidden("Only riders edit deliveries")
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "pending":
        raise conflict("Only pending deliveries can be edited", "INVALID_STATE")

    data: dict[str, Any] = {}
    if patch.get("trackingId") and patch["trackingId"] != delivery.trackingId:
        taken = await db.delivery.find_first(where={"riderId": delivery.riderId, "trackingId": patch["trackingId"], "NOT": [{"id": delivery.id}]})
        if taken:
            raise conflict(f"Parcel ID {patch['trackingId']} already exists", "DUPLICATE_TRACKING_ID")
        data["trackingId"] = patch["trackingId"]
    if patch.get("customer") is not None:
        customer = patch["customer"]
        if "name" in customer:
            data["customerName"] = customer["name"] or ""
        if "phone" in customer:
            data["customerPhone"] = customer["phone"] or ""
    if "note" in patch:
        data["note"] = patch["note"] or None
    raw = (patch.get("address") or {}).get("raw")
    if raw and normalize_address(raw) != normalize_address(delivery.addressRaw):
        data.update(addressRaw=raw, **FRESH_ADDRESS)
    return serialize_delivery(await save_delivery(delivery, data))


async def remove(actor: dict, delivery_id: str) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders delete deliveries")
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "pending":
        raise conflict("Only pending deliveries can be deleted", "INVALID_STATE")
    await db.delivery.delete(where={"id": delivery.id})  # its route stop goes with it (ON DELETE CASCADE)
    if delivery.routeId:
        await on_stop_finished(delivery.routeId)


async def clear_open(actor: dict) -> dict:
    """Removes the rider's unstarted delivery queue and any route that has not begun."""
    if actor["role"] != "rider":
        raise forbidden("Only riders delete deliveries")
    planned = await db.route.find_many(where={"riderId": actor["id"], "status": "planned"})
    deleted = await db.delivery.delete_many(where={"riderId": actor["id"], "status": "pending"})
    if planned:
        await db.route.delete_many(where={"id": {"in": [r.id for r in planned]}})
    return {"deleted": deleted, "plannedRoutesDeleted": len(planned)}


async def _require_active_route(delivery: Any) -> None:
    route = await db.route.find_unique(where={"id": delivery.routeId}) if delivery.routeId else None
    if not route or route.status != "active":
        raise conflict("Start your route before working on this delivery", "ROUTE_NOT_ACTIVE")


def _require_rider(actor: dict) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders can do this")


async def arrive(actor: dict, delivery_id: str) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status == "in_progress":
        return serialize_delivery(delivery)
    if delivery.status != "pending":
        raise conflict(f"Delivery is already {delivery.status}", "INVALID_STATE")
    await _require_active_route(delivery)
    return serialize_delivery(await save_delivery(delivery, {"status": "in_progress", "arrivedAt": now()}))


async def attach_proof(actor: dict, delivery_id: str, file: Optional[UploadedFile]) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress":
        raise conflict("Mark the delivery as Arrived before adding a photo", "INVALID_STATE")
    ext = detect_file_type(file.data if file else None, ["jpg", "png"])
    key = await storage.save(file.data, "proofs", ext)
    previous = delivery.proofPhotoKey
    try:
        saved = await save_delivery(delivery, {"proofPhotoKey": key, "proofPhotoUrl": f"/api/v1/files/{key}", "proofCapturedAt": now()})
    except Exception:
        await storage.remove(key)
        raise
    if previous:
        await storage.remove(previous)
    return serialize_delivery(saved)


async def deliver(actor: dict, delivery_id: str, note: Optional[str] = None, allow_skip: bool = False) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress":
        raise conflict("Mark the delivery as Arrived first", "INVALID_STATE")

    if delivery.routeId and delivery.stopOrder is not None and not allow_skip:
        earlier = await db.delivery.find_many(
            where={"routeId": delivery.routeId, "stopOrder": {"lt": delivery.stopOrder}, "status": {"in": ["pending", "in_progress"]}},
            order={"stopOrder": "asc"},
        )
        if earlier:
            raise conflict("Earlier deliveries are still open", "EARLIER_STOPS_REMAIN",
                           [{"trackingId": stop.trackingId, "stopOrder": stop.stopOrder} for stop in earlier])

    data: dict[str, Any] = {"status": "delivered", "deliveredAt": now()}
    if note:
        data["note"] = note
    saved = await save_delivery(delivery, data)
    if saved.routeId:
        await on_stop_finished(saved.routeId)
    return serialize_delivery(saved)


async def fail(actor: dict, delivery_id: str, reason: str, note: Optional[str] = None) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress":
        raise conflict("Mark the delivery as Arrived first", "INVALID_STATE")
    saved = await save_delivery(delivery, {"status": "failed", "failedAt": now(), "failureReason": reason, "failureNote": note or None})
    if saved.routeId:
        await on_stop_finished(saved.routeId)
    return serialize_delivery(saved)

