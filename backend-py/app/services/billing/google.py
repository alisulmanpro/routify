"""Google Play Billing verification via the Play Developer API (purchases.subscriptionsv2).

The app sends the purchase token; the server reads the subscription from Google with a service account, so nothing the
client says is trusted. Renewals, cancellations and refunds arrive as Real-time Developer Notifications through a
Pub/Sub push subscription at /api/v1/billing/webhooks/google, authenticated with a Google-signed OIDC token.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any
from urllib.parse import quote

import httpx

from ...config import env
from ...errors import AppError, unauthorized
from ...http import now
from ...logger import log
from .base import StoreState, from_rfc3339, invalid_receipt, store_unavailable

API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
TIMEOUT = 15.0

_credentials: Any = None
_lock = asyncio.Lock()


async def _access_token() -> str:
    global _credentials
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    async with _lock:
        if _credentials is None:
            _credentials = service_account.Credentials.from_service_account_file(env.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=[SCOPE])
        if not _credentials.valid:
            await asyncio.to_thread(_credentials.refresh, Request())
        return _credentials.token


async def _call(method: str, url: str) -> httpx.Response:
    try:
        token = await _access_token()
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            return await client.request(method, url, headers={"Authorization": f"Bearer {token}"}, json={} if method == "POST" else None)
    except (httpx.HTTPError, OSError, ValueError) as error:
        log(logging.ERROR, "Google Play API unreachable", error=type(error).__name__)
        raise store_unavailable("google") from None


async def fetch_subscription(purchase_token: str) -> dict:
    url = f"{API}/{quote(env.GOOGLE_PACKAGE_NAME, safe='')}/purchases/subscriptionsv2/tokens/{quote(purchase_token, safe='')}"
    response = await _call("GET", url)
    if response.status_code in (400, 404, 410):
        raise invalid_receipt()
    if response.status_code >= 300:
        log(logging.ERROR, "Google Play API error", status=response.status_code, body=response.text[:300])
        raise store_unavailable("google")
    return response.json()


async def acknowledge(product_id: str, purchase_token: str) -> None:
    """Google refunds a subscription that is not acknowledged within 3 days, so this runs once access is granted."""
    url = (f"{API}/{quote(env.GOOGLE_PACKAGE_NAME, safe='')}/purchases/subscriptions/{quote(product_id, safe='')}"
           f"/tokens/{quote(purchase_token, safe='')}:acknowledge")
    response = await _call("POST", url)
    if response.status_code >= 300:
        log(logging.ERROR, "Google Play acknowledge failed", status=response.status_code, body=response.text[:300])


_STATUS = {
    "SUBSCRIPTION_STATE_ACTIVE": "active",
    "SUBSCRIPTION_STATE_CANCELED": "active",  # auto-renew is off, but access runs to the end of the paid period
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": "grace",
    "SUBSCRIPTION_STATE_ON_HOLD": "past_due",
    "SUBSCRIPTION_STATE_PAUSED": "expired",
    "SUBSCRIPTION_STATE_EXPIRED": "expired",
}


def to_state(data: dict, purchase_token: str, event_at: Any = None) -> StoreState:
    state_name = data.get("subscriptionState", "")
    if state_name in ("SUBSCRIPTION_STATE_PENDING", "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED"):
        raise AppError(409, "PURCHASE_PENDING", "The payment is still pending with Google Play. Your plan starts once it completes.")
    items = data.get("lineItems") or []
    if not items or state_name not in _STATUS:
        raise invalid_receipt("This purchase is not a Routify subscription.")
    item = max(items, key=lambda i: i.get("expiryTime") or "")
    base_plan = (item.get("offerDetails") or {}).get("basePlanId")
    expires = from_rfc3339(item.get("expiryTime"))
    if not item.get("productId") or not base_plan or not expires:
        raise invalid_receipt("This purchase is not a Routify subscription.")
    plan = item.get("autoRenewingPlan") or {}
    price = plan.get("recurringPrice") or {}
    status = _STATUS[state_name]
    if status == "active" and expires <= now():
        status = "expired"
    return StoreState(
        store="google", purchase_key=purchase_token, product_id=f"{item['productId']}:{base_plan}", status=status, expires_at=expires,
        auto_renew=bool(plan.get("autoRenewEnabled")) and state_name != "SUBSCRIPTION_STATE_CANCELED",
        environment="sandbox" if "testPurchase" in data else "production", event_at=event_at or now(),
        transaction_id=item.get("latestSuccessfulOrderId") or data.get("latestOrderId"),
        price=(int(price.get("units") or 0) + int(price.get("nanos") or 0) / 1e9) if price.get("currencyCode") else None,
        currency=price.get("currencyCode"),
        account_token=((data.get("externalAccountIdentifiers") or {}).get("obfuscatedExternalAccountId") or None),
        linked_key=data.get("linkedPurchaseToken"),
        trial="freeTrial" in (item.get("offerPhase") or {}),
    )


def needs_acknowledgement(data: dict) -> bool:
    return data.get("acknowledgementState") == "ACKNOWLEDGEMENT_STATE_PENDING"


async def verify_purchase(purchase_token: str) -> tuple[StoreState, dict]:
    data = await fetch_subscription(purchase_token)
    return to_state(data, purchase_token), data


def _verify_push_token(authorization: str | None) -> None:
    """Pub/Sub push requests carry a Google-signed OIDC token for the service account configured on the subscription."""
    from google.auth.transport.requests import Request
    from google.oauth2 import id_token

    parts = (authorization or "").split(" ")
    if len(parts) != 2 or parts[0] != "Bearer":
        raise unauthorized("Missing push token", "INVALID_WEBHOOK")
    try:
        claims = id_token.verify_oauth2_token(parts[1], Request(), audience=env.GOOGLE_PUBSUB_AUDIENCE)
    except Exception:  # noqa: BLE001
        raise unauthorized("Invalid push token", "INVALID_WEBHOOK") from None
    if claims.get("email") != env.GOOGLE_PUBSUB_SERVICE_ACCOUNT or not claims.get("email_verified"):
        raise unauthorized("Push token from an unexpected sender", "INVALID_WEBHOOK")


async def handle_push(authorization: str | None, envelope: dict) -> tuple[StoreState, dict] | None:
    """Returns the subscription's state as Google reports it now, or None when the message needs no action."""
    await asyncio.to_thread(_verify_push_token, authorization)
    try:
        message = json.loads(base64.b64decode((envelope.get("message") or {}).get("data") or ""))
    except (ValueError, TypeError):
        raise AppError(400, "BAD_REQUEST", "Malformed Pub/Sub message") from None
    if message.get("packageName") != env.GOOGLE_PACKAGE_NAME:
        log(logging.WARNING, "Play notification for another package ignored", packageName=message.get("packageName"))
        return None
    voided = message.get("voidedPurchaseNotification")
    note = message.get("subscriptionNotification")
    token = (voided or note or {}).get("purchaseToken")
    if not token:
        return None  # test notifications and one-time products
    data = await fetch_subscription(token)
    try:
        state = to_state(data, token)  # read live from Google, so it is as fresh as anything stored
    except AppError as error:
        if error.code == "PURCHASE_PENDING":
            return None
        raise
    if voided:
        state.status, state.auto_renew = "revoked", False
        state.transaction_id = voided.get("orderId") or state.transaction_id
    return state, data
