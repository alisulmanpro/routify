from __future__ import annotations

from datetime import datetime
from typing import Any

from ..db import as_json, db, lock_rider, transaction
from ..errors import conflict, forbidden, not_found
from ..http import now, page_meta, paginate, today_key
from ..ids import new_id
from ..uploads import UploadedFile, detect_file_type
from ..validation import contains_text
from . import storage_service as storage
from .geo import normalize_address
from .geocoding_service import find_eircode, geocode_eircode, is_only_eircode, normalize_eircodes
from .route_service import on_stop_finished
from .serializers import serialize_delivery
from .stop_event_service import record as record_event
from .subscription_service import assert_can_create_deliveries

FRESH_ADDRESS = {"addressNormalized": None, "addressLatitude": None, "addressLongitude": None, "addressGeocoded": False,
                 "addressApproximate": False, "geocodeStatus": "pending"}


async def save_delivery(d: Any, data: dict) -> Any:
    """Optimistic concurrency: the write only lands if nobody else saved this delivery since we read it."""
    count = await db.delivery.update_many(where={"id": d.id, "version": d.version}, data={**data, "version": {"increment": 1}})
    if not count:
        raise conflict("This record was changed by someone else. Refresh and try again.")
    return await db.delivery.find_unique(where={"id": d.id})


async def _to_row(actor: dict, item: dict) -> dict:
    customer = item.get("customer") or {}
    # Eircodes are stored as "D01 F5P2" however they were typed, scanned, spoken or imported.
    raw = normalize_eircodes(item["address"]["raw"])
    normalized = item["address"].get("normalized") or raw
    row = {
        "id": new_id(), "riderId": actor["id"], "trackingId": item.get("trackingId") or None,
        "customerName": customer.get("name") or "", "customerPhone": customer.get("phone") or "",
        "addressRaw": raw, **FRESH_ADDRESS, "postalCode": find_eircode(raw) or find_eircode(normalized),
        "serviceDate": item.get("serviceDate") or today_key(),
    }
    # A picked suggestion, a dropped pin or a checked address is a known location, so route planning needs no lookup.
    if location := item.get("location"):
        row.update(addressLatitude=location["latitude"], addressLongitude=location["longitude"], addressNormalized=normalized,
                   addressGeocoded=True, geocodeStatus="found")
        # Only an Eircode: show the provider's address for it, and say when its match is not a rooftop one.
        # The lookup was just made by geocode-check, so this is normally a cache hit.
        if is_only_eircode(raw) and (hit := await geocode_eircode(row["postalCode"])):
            row["addressNormalized"] = hit.get("normalized") or normalized
            if hit.get("approximate"):
                row.update(addressApproximate=True, geocodeStatus="approximate")
    if item.get("note"):
        row["note"] = item["note"]
    return row


async def create_many(actor: dict, items: list[dict]) -> list[dict]:
    if actor["role"] != "rider":
        raise forbidden("Only riders create deliveries")

    rows = [await _to_row(actor, item) for item in items]
    # One rider's creates run one at a time, so parallel requests cannot both pass the plan limit.
    async with transaction() as tx:
        await lock_rider(tx, actor["id"])
        await assert_can_create_deliveries(actor, len(items), tx)

        ids = [i["trackingId"] for i in items if i.get("trackingId")]
        existing = {d.trackingId for d in await tx.delivery.find_many(where={"riderId": actor["id"], "trackingId": {"in": ids}})} if ids else set()
        in_batch: set[str] = set()
        details = []
        for index, item in enumerate(items):
            tid = item.get("trackingId")
            if not tid:
                continue
            if tid in existing:
                details.append({"index": index, "path": "trackingId", "code": "DUPLICATE", "message": f"Parcel ID {tid} already exists"})
            elif tid in in_batch:
                details.append({"index": index, "path": "trackingId", "code": "DUPLICATE", "message": f"Parcel ID {tid} appears more than once"})
            in_batch.add(tid)
        if details:
            raise conflict("Some deliveries are duplicates", "DUPLICATE_TRACKING_ID", details)
        await tx.delivery.create_many(data=rows)
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
        rx = contains_text(q["search"])
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
    if patch.get("trackingId") == "" and delivery.trackingId:
        data["trackingId"] = None
    elif patch.get("trackingId") and patch["trackingId"] != delivery.trackingId:
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
        raw = normalize_eircodes(raw)
        data.update(addressRaw=raw, **FRESH_ADDRESS, postalCode=find_eircode(raw))
    return serialize_delivery(await save_delivery(delivery, data))


async def set_location(actor: dict, delivery_id: str, latitude: float, longitude: float) -> dict:
    """The rider drops a pin for an address that could not be found (or was found in the wrong place)."""
    if actor["role"] != "rider":
        raise forbidden("Only riders edit deliveries")
    delivery = await find_visible(actor, delivery_id)
    if delivery.status not in ("pending", "in_progress"):
        raise conflict("Only open deliveries can be moved on the map", "INVALID_STATE")
    return serialize_delivery(await save_delivery(delivery, {
        "addressLatitude": latitude, "addressLongitude": longitude, "addressGeocoded": True, "addressApproximate": False, "geocodeStatus": "found",
    }))


async def archive_deleted(client: Any, rows: list[Any], reason: str) -> None:
    """Keeps a copy of stops about to be deleted (deleted_deliveries), so a delete can be looked into or undone."""
    if rows:
        await client.deleteddelivery.create_many(data=[
            {"id": d.id, "riderId": d.riderId, "routeId": d.routeId, "reason": reason, "snapshot": as_json(d.model_dump(mode="json"))} for d in rows
        ], skip_duplicates=True)


# Not copied back from a snapshot: relations, the route it was on (it may be gone or planned again) and bookkeeping.
_NOT_RESTORED = {"rider", "route", "stops", "routeId", "stopOrder", "version", "createdAt", "updatedAt"}
_DATETIMES = {"proofCapturedAt", "arrivedAt", "deliveredAt", "failedAt", "lastEventAt"}


async def list_deleted(rider_id: str, limit: int = 100) -> list[dict]:
    """A rider's deleted stops, newest first (admin console: what can be restored)."""
    rows = await db.deleteddelivery.find_many(where={"riderId": rider_id}, order={"deletedAt": "desc"}, take=limit)
    return [{"id": r.id, "riderId": r.riderId, "routeId": r.routeId, "reason": r.reason, "deletedAt": r.deletedAt,
             "trackingId": (r.snapshot or {}).get("trackingId"), "address": (r.snapshot or {}).get("addressRaw"),
             "serviceDate": (r.snapshot or {}).get("serviceDate"), "status": (r.snapshot or {}).get("status")} for r in rows]


async def restore_deleted(deleted_id: str) -> Any:
    """Puts a deleted stop back as it was (ISSUE-24), on no route: the rider plans it again. An arrived stop comes back open."""
    async with transaction() as tx:
        row = await tx.deleteddelivery.find_unique(where={"id": deleted_id})
        if not row:
            raise not_found("Deleted delivery")
        await lock_rider(tx, row.riderId)
        if await tx.delivery.find_unique(where={"id": row.id}):
            raise conflict("This delivery is already back", "ALREADY_RESTORED")
        data: dict[str, Any] = {k: v for k, v in dict(row.snapshot).items() if k not in _NOT_RESTORED and v is not None}
        for key in _DATETIMES & data.keys():
            data[key] = datetime.fromisoformat(data[key])
        if "payment" in data:
            data["payment"] = as_json(data["payment"])
        if data.get("status") == "in_progress":
            data["status"] = "pending"
        restored = await tx.delivery.create(data={**data, "id": row.id, "riderId": row.riderId})
        await tx.deleteddelivery.delete(where={"id": row.id})
    return restored


async def remove(actor: dict, delivery_id: str) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders delete deliveries")
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "pending":
        raise conflict("Only pending deliveries can be deleted", "INVALID_STATE")
    async with transaction() as tx:
        await archive_deleted(tx, [delivery], "delete")
        await tx.delivery.delete(where={"id": delivery.id})  # its route stop goes with it (ON DELETE CASCADE)
    if delivery.routeId:
        await on_stop_finished(delivery.routeId)


async def clear_open(actor: dict) -> dict:
    """Removes the rider's unstarted delivery queue and any route that has not begun. Stops on the route being driven
    are never touched (P4.6), and every removed stop is kept in deleted_deliveries."""
    if actor["role"] != "rider":
        raise forbidden("Only riders delete deliveries")
    async with transaction() as tx:
        await lock_rider(tx, actor["id"])
        planned = await tx.route.find_many(where={"riderId": actor["id"], "status": "planned"})
        rows = await tx.delivery.find_many(where={"riderId": actor["id"], "status": "pending",
                                                  "OR": [{"routeId": None}, {"route": {"is": {"status": {"not": "active"}}}}]})
        await archive_deleted(tx, rows, "clear_open")
        deleted = await tx.delivery.delete_many(where={"id": {"in": [d.id for d in rows]}}) if rows else 0
        if planned:
            await tx.route.delete_many(where={"id": {"in": [r.id for r in planned]}})
    return {"deleted": deleted, "plannedRoutesDeleted": len(planned)}


async def _require_active_route(delivery: Any) -> None:
    route = await db.route.find_unique(where={"id": delivery.routeId}) if delivery.routeId else None
    if not route or route.status != "active":
        raise conflict("Start your route before working on this delivery", "ROUTE_NOT_ACTIVE")


def _require_rider(actor: dict) -> None:
    if actor["role"] != "rider":
        raise forbidden("Only riders can do this")


async def arrive(actor: dict, delivery_id: str, *, at: Any = None, audit: bool = True) -> dict:
    """`at`: when it happened (the phone's clock, v2); `audit=False` when the caller records the event itself (v2)."""
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status == "in_progress":
        return serialize_delivery(delivery)
    if delivery.status != "pending":
        raise conflict(f"Delivery is already {delivery.status}", "INVALID_STATE")
    await _require_active_route(delivery)
    at = at or now()
    saved = await save_delivery(delivery, {"status": "in_progress", "arrivedAt": at, "lastEventAt": at})
    if audit:
        await record_event(delivery, "arrive", "applied", "in_progress", at=at, source="v1")
    return serialize_delivery(saved)


async def attach_proof(actor: dict, delivery_id: str, file: UploadedFile | None, *, allow_delivered: bool = False) -> dict:
    """`allow_delivered` (v2): the photo may also arrive after the stop was marked delivered, e.g. uploaded once back online."""
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress" and not (allow_delivered and delivery.status == "delivered"):
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


async def deliver(actor: dict, delivery_id: str, note: str | None = None, allow_skip: bool = False, *, at: Any = None, audit: bool = True) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress":
        raise conflict("Mark the delivery as Arrived first", "INVALID_STATE")

    if delivery.routeId and delivery.stopOrder is not None and not allow_skip:
        # One row is enough to refuse; the app only reads the error code (details list the first open stop).
        earlier = await db.delivery.find_many(
            where={"routeId": delivery.routeId, "stopOrder": {"lt": delivery.stopOrder}, "status": {"in": ["pending", "in_progress"]}},
            order={"stopOrder": "asc"}, take=1,
        )
        if earlier:
            raise conflict("Earlier deliveries are still open", "EARLIER_STOPS_REMAIN",
                           [{"trackingId": stop.trackingId, "stopOrder": stop.stopOrder} for stop in earlier])

    at = at or now()
    data: dict[str, Any] = {"status": "delivered", "deliveredAt": at, "lastEventAt": at}
    if note:
        data["note"] = note
    saved = await save_delivery(delivery, data)
    if audit:
        await record_event(delivery, "deliver", "applied", "delivered", at=at, source="v1", note=note)
    if saved.routeId:
        await on_stop_finished(saved.routeId)
    return serialize_delivery(saved)


async def fail(actor: dict, delivery_id: str, reason: str, note: str | None = None, *, at: Any = None, audit: bool = True) -> dict:
    _require_rider(actor)
    delivery = await find_visible(actor, delivery_id)
    if delivery.status != "in_progress":
        raise conflict("Mark the delivery as Arrived first", "INVALID_STATE")
    at = at or now()
    saved = await save_delivery(delivery, {"status": "failed", "failedAt": at, "failureReason": reason, "failureNote": note or None, "lastEventAt": at})
    if audit:
        await record_event(delivery, "fail", "applied", "failed", at=at, source="v1", reason=reason, note=note)
    if saved.routeId:
        await on_stop_finished(saved.routeId)
    return serialize_delivery(saved)

