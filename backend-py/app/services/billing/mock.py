"""A pretend store for development and testing: purchases succeed at once, and renewals, cancellations, failed payments
and refunds can be triggered on demand. Refused in production by config."""
from __future__ import annotations

import uuid
from datetime import timedelta

from ...db import db
from ...errors import AppError
from ...http import now
from ..subscription_service import add_period
from .base import StoreState, account_token

EVENTS = ("renew", "cancel", "resume", "fail_renewal", "grace", "recover", "expire", "refund")


def _key(user_id: str) -> str:
    return f"mock-{user_id}"


def purchase(user_id: str, product_id: str, *, trial_days: int = 0) -> StoreState:
    """`trial_days` starts with a free trial like the stores' free-trial offers; a `renew` event then charges the first period."""
    trial = trial_days > 0
    cycle = product_id.rsplit(".", 1)[-1]
    if cycle not in ("monthly", "annual"):
        raise AppError(422, "UNKNOWN_PRODUCT", "Mock products look like starter.monthly or pro.annual")
    at = now()
    return StoreState(store="mock", purchase_key=_key(user_id), product_id=product_id, status="active",
                      expires_at=at + timedelta(days=trial_days) if trial else add_period(at, cycle), auto_renew=True, environment="mock", event_at=at,
                      transaction_id=f"mock-{uuid.uuid4()}", account_token=account_token(user_id), trial=trial)


async def simulate(user_id: str, event: str) -> StoreState:
    row = await db.storepurchase.find_unique(where={"store_purchaseKey": {"store": "mock", "purchaseKey": _key(user_id)}})
    if not row:
        raise AppError(404, "NOT_FOUND", "Buy a plan with the mock store first")
    at = now()
    state = StoreState(store="mock", purchase_key=row.purchaseKey, product_id=row.productId, status=row.status, expires_at=row.expiresAt,
                       auto_renew=row.autoRenew, environment="mock", event_at=at)
    cycle = str(row.billingCycle)
    subscription = await db.subscription.find_unique(where={"userId": user_id})
    # Turning auto-renew off or on during a free trial leaves the trial running, as in the real stores.
    state.trial = event in ("cancel", "resume") and bool(subscription) and str(subscription.status) == "trialing"
    if event in ("renew", "recover"):
        state.status, state.auto_renew = "active", True
        state.expires_at = add_period(max(row.expiresAt, at), cycle)
        state.transaction_id = f"mock-{uuid.uuid4()}"
    elif event == "cancel":
        state.auto_renew = False
    elif event == "resume":
        state.auto_renew = True
    elif event == "fail_renewal":
        state.status, state.expires_at = "past_due", at
    elif event == "grace":
        state.status, state.expires_at = "grace", at + timedelta(days=3)
    elif event == "expire":
        state.status, state.expires_at, state.auto_renew = "expired", at, False
    elif event == "refund":
        last = await db.payment.find_first(where={"userId": user_id, "provider": "mock", "status": "succeeded"}, order={"createdAt": "desc"})
        state.status, state.auto_renew = "revoked", False
        state.transaction_id = last.storeTransactionId.split(":", 1)[1] if last and last.storeTransactionId else None
    return state
