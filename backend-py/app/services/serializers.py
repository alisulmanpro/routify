from __future__ import annotations

import re
from typing import Any

from ..security import sign_file_url

_COD_SUFFIX = re.compile(r"\s+(?:COD|cash\s+on\s+delivery)(?:\s+[A-Z]{3})?\s+([\d,]+(?:\.\d{1,2})?)\s*$", re.IGNORECASE)


def clean_delivery_address(raw: str | None, payment: Any) -> str:
    """Older imports appended "COD 1500" to addresses; strip it when it matches the stored amount."""
    address = str(raw or "")
    if not isinstance(payment, dict) or payment.get("type") != "cod":
        return address
    cod = payment.get("codAmount")
    if not isinstance(cod, (int, float)) or not cod > 0:
        return address
    suffix = _COD_SUFFIX.search(address)
    if not suffix or float(suffix.group(1).replace(",", "")) != float(cod):
        return address
    return re.sub(r"[,;\s]+$", "", address[: suffix.start()].strip())


def address_of(d: Any) -> dict:
    return {
        "raw": d.addressRaw, "normalized": d.addressNormalized, "latitude": d.addressLatitude, "longitude": d.addressLongitude,
        "geocoded": bool(d.addressGeocoded), "approximate": bool(d.addressApproximate), "geocodeStatus": str(d.geocodeStatus or "pending"),
    }


def serialize_delivery(d: Any) -> dict:
    status = str(d.geocodeStatus or "pending")
    flags = []
    if status == "not_found":
        flags.append("location_not_found")
    if status == "approximate" or d.addressApproximate:
        flags.append("approximate_location")
    address = address_of(d)
    address["raw"] = clean_delivery_address(d.addressRaw, d.payment)
    return {
        "id": d.id, "riderId": d.riderId,
        "trackingId": d.trackingId or "",
        "customer": {"name": d.customerName or "", "phone": d.customerPhone or ""},
        "address": address,
        "status": str(d.status),
        "proof": {"photoUrl": sign_file_url(d.proofPhotoKey), "capturedAt": d.proofCapturedAt} if d.proofPhotoKey else None,
        "note": d.note or None,
        "failure": {"reason": str(d.failureReason), "note": d.failureNote or None} if d.failureReason else None,
        "serviceDate": d.serviceDate, "routeId": d.routeId or None, "stopOrder": d.stopOrder,
        "arrivedAt": d.arrivedAt, "deliveredAt": d.deliveredAt, "failedAt": d.failedAt,
        "createdAt": d.createdAt, "flags": flags,
    }
