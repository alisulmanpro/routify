"""One-time copy of every record from the old MongoDB database into PostgreSQL.

IDs are kept (MongoDB ObjectIds become the same 24-char hex strings), so logins, refresh tokens,
signed file links and every client-side reference keep working after the switch.

Usage (from backend-py/):
    python -m scripts.migrate_from_mongo                 # copy, skipping rows that already exist
    python -m scripts.migrate_from_mongo --wipe          # empty the Postgres tables first, then copy
    python -m scripts.migrate_from_mongo --uploads-from ../backend/uploads   # also copy proof photos + report PDFs

Reads MONGODB_URI (source) and DATABASE_URL (target) from .env.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from bson import ObjectId
from pymongo import MongoClient

from app.db import as_json, connect, db, disconnect
from app.ids import new_id
from app.services import storage_service

ENUMS = {
    "role": {"rider", "owner_admin"}, "userStatus": {"active", "suspended"}, "preference": {"smart", "nearest_first", "shortest"},
    "areaSource": {"gps", "manual"}, "deliveryStatus": {"pending", "in_progress", "delivered", "failed"},
    "geocodeStatus": {"pending", "found", "approximate", "not_found"},
    "failureReason": {"customer_unavailable", "customer_refused", "wrong_address", "phone_unreachable", "business_closed", "payment_issue", "other"},
    "routeStatus": {"planned", "active", "completed"}, "planKey": {"trial", "starter", "pro"}, "cycle": {"monthly", "annual"},
    "subStatus": {"trialing", "active", "past_due", "expired", "cancelled"}, "paymentStatus": {"pending", "succeeded", "failed", "refunded"},
    "auditStatus": {"success", "failure"},
}
CHUNK = 500


def sid(value: Any) -> str | None:
    return str(value) if value is not None else None


def dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def enum(value: Any, kind: str, default: Any = None) -> Any:
    return value if value in ENUMS[kind] else default


def num(value: Any, default: Any = None) -> Any:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def text(value: Any, limit: int | None = None, default: Any = None) -> Any:
    if value is None:
        return default
    s = str(value)
    return s[:limit] if limit else s


def plain(value: Any) -> Any:
    """BSON → JSON-safe (ObjectIds become strings, dates ISO strings)."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return dt(value).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items() if k != "_id" or not isinstance(v, ObjectId)}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def timestamps(doc: dict) -> dict:
    out = {}
    if dt(doc.get("createdAt")):
        out["createdAt"] = dt(doc["createdAt"])
    return out


def chunks(rows: list[dict], size: int = CHUNK) -> Iterable[list[dict]]:
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


async def insert(model: Any, rows: list[dict], label: str) -> int:
    written = 0
    for part in chunks(rows):
        written += await model.create_many(data=part, skip_duplicates=True)
    print(f"  {label:<15} {len(rows):>6} read, {written:>6} written")
    return written


def convert(collection, fn: Callable[[dict], dict | None]) -> list[dict]:
    return [row for row in (fn(doc) for doc in collection.find()) if row]


async def migrate(mongo_uri: str, wipe: bool, uploads_from: str | None) -> None:
    source = MongoClient(mongo_uri, serverSelectionTimeoutMS=10_000).get_default_database()
    await connect()
    try:
        if wipe:
            await db.execute_raw('TRUNCATE "route_stops", "deliveries", "routes", "reports", "payments", "subscriptions", "refresh_tokens", '
                                 '"audit_logs", "settings", "geocode_cache", "plans", "users" CASCADE')
            print("Emptied PostgreSQL tables.")

        print(f"Copying MongoDB '{source.name}' -> PostgreSQL")

        def user(d: dict) -> dict:
            area = d.get("serviceArea") or {}
            has_area = bool(area.get("city") and area.get("countryCode") and num(area.get("latitude")) is not None and num(area.get("longitude")) is not None)
            return {
                "id": sid(d["_id"]), "fullName": text(d.get("fullName"), 120, "Rider"), "phone": text(d.get("phone"), 32, "-"),
                "email": text(d.get("email"), 254, "").strip().lower(), "passwordHash": text(d.get("passwordHash"), None, "!"),
                "role": enum(d.get("role"), "role", "rider"), "currency": text(d.get("currency"), 3, "USD"),
                "routePreference": enum(d.get("routePreference"), "preference", "smart"),
                "notificationsEnabled": d.get("notificationsEnabled") is not False, "status": enum(d.get("status"), "userStatus", "active"),
                "failedLoginCount": int(d.get("failedLoginCount") or 0), "lockedUntil": dt(d.get("lockedUntil")), "lastActiveAt": dt(d.get("lastActiveAt")),
                **({"areaCity": text(area["city"], 120), "areaCountry": text(area.get("country"), 120), "areaCountryCode": str(area["countryCode"]).lower()[:2],
                    "areaLatitude": num(area["latitude"]), "areaLongitude": num(area["longitude"]), "areaSource": enum(area.get("source"), "areaSource", "manual"),
                    "areaConfirmedAt": dt(area.get("confirmedAt"))} if has_area else {}),
                **timestamps(d),
            }

        users = convert(source.users, user)
        await insert(db.user, users, "users")
        user_ids = {u["id"] for u in users}

        def plan(d: dict) -> dict | None:
            key = enum(d.get("key"), "planKey")
            if not key:
                return None
            limits = d.get("limits") or {}
            return {"id": sid(d["_id"]), "key": key, "name": text(d.get("name"), None, key.title()), "monthlyPrice": num(d.get("monthlyPrice"), 0.0),
                    "annualPrice": num(d.get("annualPrice"), 0.0), "currency": text(d.get("currency"), 3, "USD"),
                    "deliveriesPerMonth": int(limits.get("deliveriesPerMonth") or 0), "reportsPerMonth": int(limits.get("reportsPerMonth") or 0),
                    "features": [str(f) for f in d.get("features") or []], "active": d.get("active") is not False, **timestamps(d)}

        await insert(db.plan, convert(source.plans, plan), "plans")

        def subscription(d: dict) -> dict | None:
            if sid(d.get("userId")) not in user_ids or not dt(d.get("currentPeriodEnd")):
                return None
            pending = d.get("pending") or {}
            return {"id": sid(d["_id"]), "userId": sid(d["userId"]), "planKey": enum(d.get("planKey"), "planKey", "trial"),
                    "billingCycle": enum(d.get("billingCycle"), "cycle", "monthly"), "status": enum(d.get("status"), "subStatus", "expired"),
                    "price": num(d.get("price"), 0.0), "currency": text(d.get("currency"), 3, "USD"),
                    "startedAt": dt(d.get("startedAt")) or dt(d.get("createdAt")) or datetime.now(UTC), "currentPeriodEnd": dt(d["currentPeriodEnd"]),
                    "cancelAtPeriodEnd": bool(d.get("cancelAtPeriodEnd")), "pendingPlanKey": enum(pending.get("planKey"), "planKey"),
                    "pendingBillingCycle": enum(pending.get("billingCycle"), "cycle"), "pendingPaymentId": sid(pending.get("paymentId")), **timestamps(d)}

        subscriptions = convert(source.subscriptions, subscription)
        await insert(db.subscription, subscriptions, "subscriptions")
        subscription_ids = {s["id"] for s in subscriptions}

        def payment(d: dict) -> dict | None:
            if sid(d.get("userId")) not in user_ids:
                return None
            sub_id = sid(d.get("subscriptionId"))
            return {"id": sid(d["_id"]), "userId": sid(d["userId"]), "subscriptionId": sub_id if sub_id in subscription_ids else None,
                    "planKey": enum(d.get("planKey"), "planKey", "starter"), "billingCycle": enum(d.get("billingCycle"), "cycle", "monthly"),
                    "amount": num(d.get("amount"), 0.0), "currency": text(d.get("currency"), 3, "USD"), "status": enum(d.get("status"), "paymentStatus", "pending"),
                    "provider": text(d.get("provider"), None, "manual"), "providerRef": text(d.get("providerRef")), "paidAt": dt(d.get("paidAt")), **timestamps(d)}

        await insert(db.payment, convert(source.payments, payment), "payments")

        route_docs = [r for r in source.routes.find() if sid(r.get("riderId")) in user_ids]

        def route(d: dict) -> dict:
            origin = d.get("origin") or {}
            return {"id": sid(d["_id"]), "riderId": sid(d["riderId"]), "serviceDate": text(d.get("serviceDate"), 10, ""),
                    "preference": enum(d.get("preference"), "preference", "smart"), "status": enum(d.get("status"), "routeStatus", "completed"),
                    "originLatitude": num(origin.get("latitude")), "originLongitude": num(origin.get("longitude")),
                    "distanceKm": num(d.get("distanceKm"), 0.0), "durationMin": num(d.get("durationMin"), 0.0),
                    "startedAt": dt(d.get("startedAt")), "completedAt": dt(d.get("completedAt")), **timestamps(d)}

        routes = [route(r) for r in route_docs]
        await insert(db.route, routes, "routes")
        route_ids = {r["id"] for r in routes}

        def delivery(d: dict) -> dict | None:
            if sid(d.get("riderId")) not in user_ids:
                return None
            customer, address, proof, failure = d.get("customer") or {}, d.get("address") or {}, d.get("proof") or {}, d.get("failure") or {}
            route_id = sid(d.get("routeId"))
            row = {
                "id": sid(d["_id"]), "riderId": sid(d["riderId"]), "trackingId": text(d.get("trackingId"), 80, ""),
                "customerName": text(customer.get("name"), 160, ""), "customerPhone": text(customer.get("phone"), 32, ""),
                "addressRaw": text(address.get("raw"), 400, ""), "addressNormalized": text(address.get("normalized")),
                "addressLatitude": num(address.get("latitude")), "addressLongitude": num(address.get("longitude")),
                "addressGeocoded": bool(address.get("geocoded")), "addressApproximate": bool(address.get("approximate")),
                "geocodeStatus": enum(address.get("geocodeStatus"), "geocodeStatus", "pending"),
                "status": enum(d.get("status"), "deliveryStatus", "pending"),
                "proofPhotoKey": text(proof.get("photoKey")), "proofPhotoUrl": text(proof.get("photoUrl")), "proofCapturedAt": dt(proof.get("capturedAt")),
                "note": text(d.get("note"), 1000), "failureReason": enum(failure.get("reason"), "failureReason"), "failureNote": text(failure.get("note"), 1000),
                "serviceDate": text(d.get("serviceDate"), 10, ""), "routeId": route_id if route_id in route_ids else None,
                "stopOrder": int(d["stopOrder"]) if isinstance(d.get("stopOrder"), (int, float)) else None,
                "arrivedAt": dt(d.get("arrivedAt")), "deliveredAt": dt(d.get("deliveredAt")), "failedAt": dt(d.get("failedAt")),
                "version": int(d.get("__v") or 0), **timestamps(d),
            }
            if d.get("payment"):
                row["payment"] = as_json(plain(d["payment"]))
            return row

        deliveries = convert(source.deliveries, delivery)
        await insert(db.delivery, deliveries, "deliveries")
        delivery_ids = {d["id"] for d in deliveries}

        stops: list[dict] = []
        for r in route_docs:
            seen: set[str] = set()
            for s in r.get("stops") or []:
                did = sid(s.get("deliveryId"))
                if did in delivery_ids and did not in seen:
                    seen.add(did)
                    stops.append({"routeId": sid(r["_id"]), "deliveryId": did, "order": int(s.get("order") or 0),
                                  "legDistanceKm": num(s.get("legDistanceKm"), 0.0), "legDurationMin": num(s.get("legDurationMin"), 0.0)})
        await insert(db.routestop, stops, "route stops")

        def report(d: dict) -> dict | None:
            if sid(d.get("riderId")) not in user_ids or not d.get("fileKey"):
                return None
            return {"id": sid(d["_id"]), "riderId": sid(d["riderId"]), "date": text(d.get("date"), 10, ""), "summary": as_json(plain(d.get("summary") or {})),
                    "fileKey": str(d["fileKey"]), "fileSize": int(d["fileSize"]) if isinstance(d.get("fileSize"), (int, float)) else None,
                    "generatedAt": dt(d.get("generatedAt")) or dt(d.get("createdAt")) or datetime.now(UTC), **timestamps(d)}

        await insert(db.report, convert(source.reports, report), "reports")

        def refresh_token(d: dict) -> dict | None:
            if sid(d.get("userId")) not in user_ids or not d.get("tokenHash") or not dt(d.get("expiresAt")):
                return None
            return {"id": sid(d["_id"]), "userId": sid(d["userId"]), "family": text(d.get("family"), None, new_id()), "tokenHash": str(d["tokenHash"]),
                    "expiresAt": dt(d["expiresAt"]), "revokedAt": dt(d.get("revokedAt")), "replacedByHash": text(d.get("replacedByHash")),
                    "userAgent": text(d.get("userAgent"), 300), **timestamps(d)}

        await insert(db.refreshtoken, convert(source.refreshtokens, refresh_token), "refresh tokens")

        def audit_log(d: dict) -> dict:
            row = {"id": sid(d["_id"]), "actorId": sid(d.get("actorId")), "actorEmail": text(d.get("actorEmail")), "action": text(d.get("action"), None, "unknown"),
                   "targetType": text(d.get("targetType")), "targetId": text(d.get("targetId")), "status": enum(d.get("status"), "auditStatus", "success"),
                   "ip": text(d.get("ip")), **timestamps(d)}
            if d.get("meta") is not None:
                row["meta"] = as_json(plain(d["meta"]))
            return row

        await insert(db.auditlog, convert(source.auditlogs, audit_log), "audit logs")

        await insert(db.setting, convert(source.settings, lambda d: {"id": sid(d["_id"]), "key": str(d["key"]), "value": as_json(plain(d.get("value"))),
                                                                     **timestamps(d)} if d.get("key") else None), "settings")

        def cache(d: dict) -> dict | None:
            if not d.get("key") or not dt(d.get("expiresAt")):
                return None
            return {"key": str(d["key"]), "found": bool(d.get("found")), "latitude": num(d.get("latitude")), "longitude": num(d.get("longitude")),
                    "normalized": text(d.get("normalized")), "approximate": bool(d.get("approximate")), "provider": text(d.get("provider")), "expiresAt": dt(d["expiresAt"])}

        await insert(db.geocodecache, convert(source.geocodecaches, cache), "geocode cache")
    finally:
        await disconnect()

    if uploads_from:
        copy_uploads(Path(uploads_from))


def copy_uploads(src: Path) -> None:
    dest = storage_service.root()
    if not src.is_dir():
        print(f"  uploads: {src} not found, skipped")
        return
    if src.resolve() == dest:
        print("  uploads: source and STORAGE_DIR are the same folder, nothing to copy")
        return
    copied = 0
    for kind in ("proofs", "reports"):
        for file in (src / kind).glob("*") if (src / kind).is_dir() else []:
            target = dest / kind / file.name
            if file.is_file() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
                copied += 1
    print(f"  uploads: copied {copied} file(s) into {dest}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mongo-uri", default=os.environ.get("MONGODB_URI"), help="source MongoDB URI (default: MONGODB_URI from .env)")
    parser.add_argument("--wipe", action="store_true", help="empty the PostgreSQL tables before copying")
    parser.add_argument("--uploads-from", help="also copy proof photos and report PDFs from this folder (e.g. ../backend/uploads)")
    args = parser.parse_args()
    if not args.mongo_uri:
        print("Set MONGODB_URI in .env or pass --mongo-uri.", file=sys.stderr)
        return 1
    asyncio.run(migrate(args.mongo_uri, args.wipe, args.uploads_from))
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
