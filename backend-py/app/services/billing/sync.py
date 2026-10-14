"""Applies a verified store state to the rider's subscription and payment history. Safe to run any number of times."""
from __future__ import annotations

import logging
from typing import Any

from prisma.errors import UniqueViolationError

from ...db import db
from ...errors import AppError, conflict
from ...http import now
from ...ids import new_id
from ...logger import log
from ..settings_service import get_settings
from .base import ACCESS_STATUSES, LIVE_STATUSES, StoreState, account_token, catalog


async def _find(state: StoreState) -> tuple[Any, Any]:
    """The stored purchase for this state, and the one it replaced (Google issues a new token on plan changes)."""
    current = await db.storepurchase.find_unique(where={"store_purchaseKey": {"store": state.store, "purchaseKey": state.purchase_key}})
    replaced = None
    if state.linked_key:
        replaced = await db.storepurchase.find_unique(where={"store_purchaseKey": {"store": state.store, "purchaseKey": state.linked_key}})
    return current, replaced


async def _record_payment(user_id: str, subscription_id: str | None, state: StoreState, plan: Any, cycle: str) -> None:
    if not state.transaction_id or state.status not in ACCESS_STATUSES or state.trial:
        return  # a free-trial period charges nothing, so it is not a payment
    price = state.price if state.price is not None else (plan.annualPrice if cycle == "annual" else plan.monthlyPrice)
    try:
        await db.payment.create(data={
            "id": new_id(), "userId": user_id, "subscriptionId": subscription_id, "planKey": plan.key, "billingCycle": cycle,
            "amount": round(price, 2), "currency": (state.currency or plan.currency)[:3].upper(), "status": "succeeded", "provider": state.store,
            "providerRef": state.purchase_key[:200], "storeTransactionId": f"{state.store}:{state.transaction_id}"[:200],
            "testMode": state.test_mode, "paidAt": now(),
        })
    except UniqueViolationError:
        pass  # this billing period is already recorded (receipt sent twice, or webhook + app both reported it)


async def apply_state(state: StoreState, user_id: str | None, *, authoritative: bool = True) -> Any:
    """`user_id` is the signed-in rider for purchases reported by the app, None for store webhooks.
    `authoritative` is False when the state comes from a receipt the app sent (Apple): such a receipt may be an old
    transaction, so it can extend or create a purchase but never shorten one the store itself reported.

    Returns the stored purchase, or None when a webhook concerns a purchase no rider has reported yet
    (the app reports every purchase right after it completes, which links it then).
    """
    settings = await get_settings()
    resolved = catalog(settings, state.store).get(state.product_id)
    if not resolved:
        if user_id:
            raise AppError(422, "UNKNOWN_PRODUCT", "This product is not one of the plans on sale.")
        log(logging.WARNING, "Store event for an unknown product ignored", store=state.store, productId=state.product_id)
        return None
    plan_key, cycle = resolved
    plan = await db.plan.find_unique(where={"key": plan_key})

    current, replaced = await _find(state)
    owner = (current or replaced).userId if (current or replaced) else user_id
    if not owner:
        log(logging.INFO, "Store event for a purchase not linked to a rider yet", store=state.store)
        return None
    if user_id and owner != user_id:
        raise conflict("This purchase belongs to a different Routify account. Sign in with that account to use it.", "PURCHASE_OTHER_ACCOUNT")
    if state.account_token and state.account_token != account_token(owner):
        if user_id:
            raise conflict("This purchase was made for a different Routify account.", "PURCHASE_OTHER_ACCOUNT")
        log(logging.WARNING, "Store event whose account token does not match the linked rider ignored", store=state.store)
        return None
    if current and current.lastEventAt > state.event_at:
        return current  # an older event arriving late must not roll back a newer state
    if current and not authoritative and state.expires_at < current.expiresAt:
        return current

    fields = {"productId": state.product_id[:200], "planKey": plan_key, "billingCycle": cycle, "status": state.status, "autoRenew": state.auto_renew,
              "expiresAt": state.expires_at, "environment": state.environment, "lastEventAt": state.event_at}
    purchase = await db.storepurchase.upsert(
        where={"store_purchaseKey": {"store": state.store, "purchaseKey": state.purchase_key}},
        data={"create": {"id": new_id(), "userId": owner, "store": state.store, "purchaseKey": state.purchase_key, **fields}, "update": fields},
    )
    if replaced and replaced.id != purchase.id and replaced.status in LIVE_STATUSES:
        await db.storepurchase.update(where={"id": replaced.id}, data={"status": "expired", "autoRenew": False})

    subscription = await db.subscription.find_unique(where={"userId": owner})
    await _record_payment(owner, subscription.id if subscription else None, state, plan, cycle)
    if state.status == "revoked" and state.transaction_id:
        await db.payment.update_many(where={"storeTransactionId": f"{state.store}:{state.transaction_id}", "status": "succeeded"},
                                     data={"status": "refunded"})
    if subscription:
        await _update_subscription(subscription, purchase, replaced, state, plan, cycle)
    return purchase


async def _update_subscription(subscription: Any, purchase: Any, replaced: Any, state: StoreState, plan: Any, cycle: str) -> None:
    sources = {purchase.id, replaced.id if replaced else None}
    is_source = subscription.storePurchaseId in sources

    if state.status in LIVE_STATUSES:
        if not is_source and subscription.storePurchaseId:
            other = await db.storepurchase.find_unique(where={"id": subscription.storePurchaseId})
            if other and other.status in ACCESS_STATUSES and other.expiresAt > state.expires_at:
                return  # the rider has another, longer-running store subscription; keep using that one
        if subscription.pendingPaymentId:  # a manual plan request is superseded by the store purchase
            await db.payment.update_many(where={"id": subscription.pendingPaymentId, "status": "pending"}, data={"status": "failed"})
        same_plan = is_source and str(subscription.planKey) == plan.key
        await db.subscription.update(where={"id": subscription.id}, data={
            "planKey": plan.key, "billingCycle": cycle,
            "status": "past_due" if state.status == "past_due" else "trialing" if state.trial else "active",
            "currentPeriodEnd": state.expires_at, "cancelAtPeriodEnd": not state.auto_renew,
            "price": state.price if state.price is not None else (plan.annualPrice if cycle == "annual" else plan.monthlyPrice),
            "currency": (state.currency or plan.currency)[:3].upper(), "storePurchaseId": purchase.id,
            "startedAt": subscription.startedAt if same_plan else now(),
            "pendingPlanKey": None, "pendingBillingCycle": None, "pendingPaymentId": None,
        })
    elif is_source:
        # Ended, refunded or revoked: access stops (a refund stops it at once), and the rider can buy again.
        end = min(state.expires_at, now()) if state.status == "revoked" else state.expires_at
        await db.subscription.update(where={"id": subscription.id}, data={
            "status": "expired", "currentPeriodEnd": min(end, subscription.currentPeriodEnd) if state.status == "revoked" else end,
            "cancelAtPeriodEnd": False, "storePurchaseId": None,
        })
