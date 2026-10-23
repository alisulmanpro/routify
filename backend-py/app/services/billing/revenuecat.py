"""RevenueCat: one SDK in the app for Google Play, the App Store and RevenueCat's Test Store.

The app identifies each rider to RevenueCat with their Routify user id (`Purchases.logIn(user.id)`), so the server
reads that rider's state straight from RevenueCat's REST API with the secret key: nothing the app sends is trusted.
After a purchase the app calls POST /subscriptions/purchases {store: "revenuecat"}; renewals, cancellations, billing
problems and refunds arrive at /api/v1/billing/webhooks/revenuecat, where every event simply triggers a fresh read
(RevenueCat's recommended way to stay in sync, rather than interpreting each event type).
"""
from __future__ import annotations

import hmac
import logging
from datetime import timedelta
from urllib.parse import quote

import httpx

from ...config import env
from ...db import db
from ...errors import unauthorized
from ...http import now
from ...ids import is_object_id
from ...logger import log
from .base import StoreState, catalog, from_rfc3339, store_unavailable

API = "https://api.revenuecat.com/v1"
TIMEOUT = 15.0
LIFETIME = timedelta(days=36500)  # a non-expiring entitlement (lifetime / promotional) never lapses


def purchase_key(user_id: str) -> str:
    """RevenueCat merges a rider's purchases into one customer, so one stored purchase per rider."""
    return f"rc:{user_id}"


async def fetch_subscriber(app_user_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(f"{API}/subscribers/{quote(app_user_id, safe='')}",
                                        headers={"Authorization": f"Bearer {env.REVENUECAT_SECRET_API_KEY}"})
    except httpx.HTTPError as error:
        log(logging.ERROR, "RevenueCat API unreachable", error=type(error).__name__)
        raise store_unavailable("revenuecat") from None
    if response.status_code >= 300:
        log(logging.ERROR, "RevenueCat API error", status=response.status_code, body=response.text[:300])
        raise store_unavailable("revenuecat")
    return (response.json() or {}).get("subscriber") or {}


def _catalog_product(settings: dict, product: str) -> str:
    """Maps a RevenueCat product id onto the plan catalog. Ids not listed there still map by their billing period, so a
    store-specific id (routify_pro:monthly, routify.pro.annual) works without editing the catalog."""
    known = catalog(settings, "revenuecat")
    if product in known:
        return product
    cycle = "annual" if any(word in product.lower() for word in ("year", "annual", "12m", "p1y")) else "monthly"
    return next((pid for pid, (plan, c) in known.items() if plan == "pro" and c == cycle), product)


def to_state(subscriber: dict, user_id: str, settings: dict) -> StoreState | None:
    """The rider's routify_pro entitlement as a store state, or None when they have never had it."""
    entitlement = (subscriber.get("entitlements") or {}).get(env.REVENUECAT_ENTITLEMENT)
    if not entitlement:
        return None
    product = entitlement.get("product_identifier") or ""
    sub = (subscriber.get("subscriptions") or {}).get(product) or {}
    at = now()
    expires = from_rfc3339(sub.get("expires_date") or entitlement.get("expires_date")) or at + LIFETIME
    grace = from_rfc3339(sub.get("grace_period_expires_date") or entitlement.get("grace_period_expires_date"))
    if sub.get("refunded_at"):
        status = "revoked"
    elif expires > at:
        status = "active"
    elif grace and grace > at:
        status, expires = "grace", grace
    elif sub.get("billing_issues_detected_at"):
        status = "past_due"
    else:
        status = "expired"
    price = sub.get("price") if isinstance(sub.get("price"), dict) else {}
    sandbox = bool(sub.get("is_sandbox")) or sub.get("store") == "test_store"
    return StoreState(
        store="revenuecat", purchase_key=purchase_key(user_id), product_id=_catalog_product(settings, product), status=status,
        expires_at=expires, auto_renew=not sub.get("unsubscribe_detected_at"), environment="sandbox" if sandbox else "production",
        event_at=at, transaction_id=sub.get("store_transaction_id"),
        price=float(price["amount"]) if price.get("amount") is not None else None, currency=price.get("currency"),
        trial=sub.get("period_type") == "trial",
    )


async def current_state(user_id: str, settings: dict) -> StoreState | None:
    """Reads the rider from RevenueCat. An entitlement that disappeared entirely ends the stored purchase."""
    state = to_state(await fetch_subscriber(user_id), user_id, settings)
    if state:
        return state
    row = await db.storepurchase.find_unique(where={"store_purchaseKey": {"store": "revenuecat", "purchaseKey": purchase_key(user_id)}})
    if not row:
        return None
    return StoreState(store="revenuecat", purchase_key=row.purchaseKey, product_id=row.productId, status="expired", expires_at=now(),
                      auto_renew=False, environment=row.environment, event_at=now())


def verify_webhook(authorization: str | None) -> None:
    """RevenueCat sends the Authorization header value set on the webhook in its dashboard."""
    expected = env.REVENUECAT_WEBHOOK_AUTH or ""
    if not authorization or not expected or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise unauthorized("Invalid webhook authorization", "INVALID_WEBHOOK")


def webhook_user_ids(event: dict) -> list[str]:
    """Every Routify rider an event concerns (a TRANSFER names both sides). Anonymous RevenueCat ids are skipped."""
    ids = [event.get("app_user_id"), event.get("original_app_user_id"), *(event.get("transferred_from") or []), *(event.get("transferred_to") or [])]
    return list(dict.fromkeys(i for i in ids if isinstance(i, str) and is_object_id(i)))
