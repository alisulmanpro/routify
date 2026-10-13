"""In-app subscriptions through the App Store and Google Play (plus a mock store for testing).

Flow: the app asks GET /subscriptions/store for product IDs and the rider's account token, buys through StoreKit or
Play Billing, then sends the receipt to POST /subscriptions/purchases. The server verifies it with the store and
activates the plan. Renewals, cancellations, billing problems and refunds then arrive from the stores' webhooks.
Enabled stores are set with PAYMENT_STORES (see .env.example).
"""
from __future__ import annotations

from ...config import env
from ...db import db
from ...errors import AppError
from ..settings_service import get_settings
from . import apple, google, mock
from .base import LIVE_STATUSES, account_token, catalog
from .sync import apply_state

STORE_NAMES = {"apple": "the App Store", "google": "Google Play", "mock": "the test store"}


def _require(store: str) -> None:
    if store not in env.payment_stores:
        raise AppError(400, "STORE_DISABLED", f"Purchases through {STORE_NAMES.get(store, store)} are not enabled.")


async def store_config(actor: dict) -> dict:
    """What the app needs to show the store's paywall and tag the purchase with this rider's account."""
    settings = await get_settings()
    products = {}
    for store in env.payment_stores:
        products[store] = [{"productId": pid.split(":")[0] if store == "google" else pid, **({"basePlanId": pid.split(":")[1]} if store == "google" else {}),
                            "planKey": plan, "billingCycle": cycle} for pid, (plan, cycle) in catalog(settings, store).items()]
    # One free trial per account, as the stores allow. The real stores have the final say (their SDK reports eligibility).
    trial_eligible = {store: not await _has_purchased(actor["id"], store) for store in env.payment_stores}
    days = settings["trialDays"]
    for item in products.get("google", []):
        item["trialOfferId"] = trial_offer_id(days)  # the base-plan offer the app asks Google Play for
    return {"stores": list(env.payment_stores), "accountToken": account_token(actor["id"]), "products": products,
            "trialEligible": trial_eligible, "trialDays": days}


def trial_offer_id(days: int) -> str:
    """Play Console offer ID for each free-trial length the admin can choose: free-trial-7d, free-trial-14d, free-trial-30d."""
    return f"free-trial-{days}d"


async def _has_purchased(user_id: str, store: str) -> bool:
    return bool(await db.storepurchase.count(where={"userId": user_id, "store": store}))


async def verify_purchase(actor: dict, store: str, *, receipt: str | None, product_id: str | None, trial: bool = False) -> None:
    _require(store)
    if store == "mock":
        if not product_id:
            raise AppError(400, "VALIDATION_ERROR", "productId is required for the mock store")
        trial = trial and not await _has_purchased(actor["id"], "mock")
        days = (await get_settings())["trialDays"] if trial else 0
        await apply_state(mock.purchase(actor["id"], product_id, trial_days=days), actor["id"])
        return
    if not receipt:
        raise AppError(400, "VALIDATION_ERROR", "receipt is required")
    if store == "apple":
        await apply_state(await apple.verify_transaction(receipt), actor["id"], authoritative=False)
        return
    state, data = await google.verify_purchase(receipt)
    if product_id and product_id.split(":")[0] != state.product_id.split(":")[0]:
        raise AppError(422, "INVALID_RECEIPT", "The purchase does not match the product.")
    purchase = await apply_state(state, actor["id"])
    if purchase and state.status in LIVE_STATUSES and google.needs_acknowledgement(data):
        await google.acknowledge(state.product_id.split(":")[0], receipt)


async def simulate_mock_event(actor: dict, event: str) -> None:
    _require("mock")
    await apply_state(await mock.simulate(actor["id"], event), actor["id"])


async def handle_apple_webhook(signed_payload: str) -> None:
    _require("apple")
    state = await apple.handle_notification(signed_payload)
    if state:
        await apply_state(state, None)


async def handle_google_webhook(authorization: str | None, envelope: dict) -> None:
    _require("google")
    result = await google.handle_push(authorization, envelope)
    if not result:
        return
    state, data = result
    purchase = await apply_state(state, None)
    if purchase and state.status in LIVE_STATUSES and google.needs_acknowledgement(data):
        await google.acknowledge(state.product_id.split(":")[0], state.purchase_key)

