from __future__ import annotations

import asyncio
import calendar
from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import db
from ..errors import AppError, conflict, not_found, unprocessable
from ..http import now
from ..ids import new_id
from .settings_service import get_settings


async def ensure_default_plans() -> None:
    """First-run defaults. Prices/limits are placeholders: owners edit them in Admin → Plans."""
    if await db.plan.count():
        return
    currency = (await get_settings())["defaultCurrency"]
    base = ["PDF import", "Route planning", "Daily reports"]
    await db.plan.create_many(data=[
        {"id": new_id(), "key": "trial", "name": "Free Trial", "monthlyPrice": 0, "annualPrice": 0, "currency": currency, "deliveriesPerMonth": 100, "reportsPerMonth": 31, "features": base},
        {"id": new_id(), "key": "starter", "name": "Starter", "monthlyPrice": 19, "annualPrice": 190, "currency": currency, "deliveriesPerMonth": 1000, "reportsPerMonth": 100, "features": base},
        {"id": new_id(), "key": "pro", "name": "Pro", "monthlyPrice": 49, "annualPrice": 490, "currency": currency, "deliveriesPerMonth": 10000, "reportsPerMonth": 1000, "features": [*base, "Priority support"]},
    ], skip_duplicates=True)


def add_period(start: datetime, cycle: str) -> datetime:
    """JS setUTCMonth semantics: Jan 31 + 1 month overflows into March, exactly like the Node API."""
    months = 12 if cycle == "annual" else 1
    total = start.month - 1 + months
    year, month = start.year + total // 12, total % 12 + 1
    overflow = max(0, start.day - calendar.monthrange(year, month)[1])
    day = start.day - overflow
    return start.replace(year=year, month=month, day=day) + timedelta(days=overflow)


def effective_status(sub: Any) -> str:
    if not sub:
        return "expired"
    status = str(sub.status)
    if status in ("inactive", "expired", "cancelled"):
        return status
    return "expired" if sub.currentPeriodEnd < now() else status


async def create_inactive_subscription(user_id: str) -> Any:
    """A new rider starts with no plan: the free trial needs a payment method, so it starts through Google Play / the App Store
    (length set by the admin in settings.trialDays). This row is what the store purchase or an admin payment then activates."""
    settings = await get_settings()
    return await db.subscription.create(data={
        "id": new_id(), "userId": user_id, "planKey": "trial", "billingCycle": "monthly", "status": "inactive", "price": 0,
        "currency": settings["defaultCurrency"], "currentPeriodEnd": now(),
    })


def month_start() -> datetime:
    d = now()
    return datetime(d.year, d.month, 1, tzinfo=timezone.utc)


async def get_usage(actor: dict, client: Any = None) -> dict:
    since = month_start()
    client = client or db
    deliveries, reports = await asyncio.gather(
        client.delivery.count(where={"riderId": actor["id"], "createdAt": {"gte": since}}),
        client.report.count(where={"riderId": actor["id"], "createdAt": {"gte": since}}),
    )
    return {"deliveriesThisMonth": deliveries, "reportsThisMonth": reports}


def serialize_plan(p: Any) -> dict:
    return {
        "id": p.id, "key": str(p.key), "name": p.name, "monthlyPrice": p.monthlyPrice, "annualPrice": p.annualPrice, "currency": p.currency,
        "limits": {"deliveriesPerMonth": p.deliveriesPerMonth, "reportsPerMonth": p.reportsPerMonth}, "features": list(p.features or []), "active": p.active,
    }


def serialize_subscription(s: Any) -> dict | None:
    if not s:
        return None
    return {
        "id": s.id, "userId": s.userId,
        "planKey": str(s.planKey), "billingCycle": str(s.billingCycle), "status": effective_status(s), "price": s.price, "currency": s.currency,
        "startedAt": s.startedAt, "currentPeriodEnd": s.currentPeriodEnd, "cancelAtPeriodEnd": s.cancelAtPeriodEnd,
        "pending": {"planKey": str(s.pendingPlanKey), "billingCycle": str(s.pendingBillingCycle) if s.pendingBillingCycle else None, "paymentId": s.pendingPaymentId}
        if s.pendingPlanKey else None,
        "storeManaged": bool(s.storePurchaseId),
    }


def serialize_store_purchase(p: Any) -> dict | None:
    if not p:
        return None
    return {"store": p.store, "productId": p.productId, "status": p.status, "autoRenew": p.autoRenew, "expiresAt": p.expiresAt,
            "testMode": p.environment != "production"}


STORE_LABEL = {"apple": "the App Store", "google": "Google Play", "mock": "the test store"}


async def live_store_purchase(subscription: Any) -> Any:
    """The store purchase billing this subscription while it is live: the rider changes or cancels it in the store, not here."""
    if not subscription or not subscription.storePurchaseId:
        return None
    purchase = await db.storepurchase.find_unique(where={"id": subscription.storePurchaseId})
    return purchase if purchase and purchase.status in ("active", "grace", "past_due") else None


async def _refuse_if_store_managed(subscription: Any) -> None:
    purchase = await live_store_purchase(subscription)
    if purchase:
        raise conflict(f"Your plan is billed through {STORE_LABEL.get(purchase.store, purchase.store)}. "
                       "Change or cancel it in your phone's subscription settings.", "STORE_MANAGED")


async def get_mine(actor: dict) -> dict:
    subscription, plans, usage = await asyncio.gather(
        db.subscription.find_unique(where={"userId": actor["id"]}),
        db.plan.find_many(where={"active": True}, order={"monthlyPrice": "asc"}),
        get_usage(actor),
    )
    pending_key = subscription.pendingPlanKey if subscription else None
    pending_plan = await db.plan.find_first(where={"key": pending_key, "active": True}) if pending_key else None
    plan = pending_plan or next((p for p in plans if subscription and p.key == subscription.planKey), None)
    if not plan and subscription:
        plan = await db.plan.find_unique(where={"key": subscription.planKey})
    return {
        "subscription": serialize_subscription(subscription), "store": serialize_store_purchase(await live_store_purchase(subscription)),
        "plan": serialize_plan(plan) if plan else None,
        "plans": [serialize_plan(p) for p in plans], "usage": usage,
        "paymentInstructions": (await get_settings())["platform"]["paymentInstructions"],
    }


async def assert_can_create_deliveries(actor: dict, count: int = 1, client: Any = None) -> None:
    """Blocks new deliveries when the subscription is not usable or the monthly limit would be exceeded.

    Pass the transaction that inserts the deliveries as `client` so the count and the insert see the same data.
    """
    client = client or db
    subscription = await client.subscription.find_unique(where={"userId": actor["id"]})
    status = effective_status(subscription)
    if status == "inactive":
        raise AppError(403, "SUBSCRIPTION_REQUIRED", "Start your free trial or choose a plan to add deliveries.")
    if status not in ("trialing", "active"):
        message = ("Your last payment failed. Update your subscription to add deliveries." if status == "past_due"
                   else "Your subscription has expired. Upgrade to add new deliveries.")
        raise AppError(403, "SUBSCRIPTION_EXPIRED", message)
    plan = await client.plan.find_unique(where={"key": subscription.planKey})
    if not plan:
        return
    used = (await get_usage(actor, client))["deliveriesThisMonth"]
    if used + count > plan.deliveriesPerMonth:
        raise AppError(403, "PLAN_LIMIT_REACHED", f"Your {plan.name} plan allows {plan.deliveriesPerMonth} deliveries per month ({used} used).")


async def assert_can_create_report(actor: dict, is_new_report: bool, client: Any = None) -> None:
    if not is_new_report:
        return
    client = client or db
    subscription = await client.subscription.find_unique(where={"userId": actor["id"]})
    plan = await client.plan.find_unique(where={"key": subscription.planKey}) if subscription else None
    if not plan:
        return
    if (await get_usage(actor, client))["reportsThisMonth"] + 1 > plan.reportsPerMonth:
        raise AppError(403, "PLAN_LIMIT_REACHED", f"Your {plan.name} plan allows {plan.reportsPerMonth} reports per month.")


def price_for(plan: Any, cycle: str) -> float:
    return plan.annualPrice if cycle == "annual" else plan.monthlyPrice


_NO_PENDING = {"pendingPlanKey": None, "pendingBillingCycle": None, "pendingPaymentId": None}


async def _fail_pending_payment(subscription: Any) -> None:
    if subscription.pendingPaymentId:
        await db.payment.update_many(where={"id": subscription.pendingPaymentId, "status": "pending"}, data={"status": "failed"})


async def request_change(actor: dict, plan_key: str, billing_cycle: str) -> dict:
    plan = await db.plan.find_first(where={"key": plan_key, "active": True})
    if not plan or plan.key == "trial":
        raise unprocessable("That plan is not available", "PLAN_UNAVAILABLE")
    subscription = await db.subscription.find_unique(where={"userId": actor["id"]})
    if not subscription:
        raise not_found("Subscription")
    await _refuse_if_store_managed(subscription)
    await _fail_pending_payment(subscription)
    payment = await db.payment.create(data={
        "id": new_id(), "userId": actor["id"], "subscriptionId": subscription.id, "planKey": plan_key, "billingCycle": billing_cycle,
        "amount": price_for(plan, billing_cycle), "currency": plan.currency, "status": "pending", "provider": "manual",
    })
    subscription = await db.subscription.update(where={"id": subscription.id}, data={
        "pendingPlanKey": plan_key, "pendingBillingCycle": billing_cycle, "pendingPaymentId": payment.id, "cancelAtPeriodEnd": False,
    })
    return {"payment": {"id": payment.id, "amount": payment.amount, "currency": payment.currency, "status": str(payment.status)},
            "subscription": serialize_subscription(subscription)}


async def cancel_at_period_end(actor: dict) -> dict:
    subscription = await db.subscription.find_unique(where={"userId": actor["id"]})
    if not subscription:
        raise not_found("Subscription")
    if subscription.planKey == "trial":
        raise conflict("A free trial simply ends on its own", "CANNOT_CANCEL_TRIAL")
    await _refuse_if_store_managed(subscription)
    data: dict[str, Any] = {"cancelAtPeriodEnd": True}
    if subscription.pendingPaymentId:
        await _fail_pending_payment(subscription)
        data.update(_NO_PENDING)
    return serialize_subscription(await db.subscription.update(where={"id": subscription.id}, data=data))


async def apply_succeeded_payment(payment: Any) -> Any:
    """Called when a payment becomes `succeeded`: activates or renews the paid plan."""
    subscription = await db.subscription.find_unique(where={"userId": payment.userId})
    if not subscription:
        raise not_found("Subscription")
    renewing = subscription.planKey == payment.planKey and effective_status(subscription) == "active"
    start = subscription.currentPeriodEnd if renewing else now()
    return await db.subscription.update(where={"id": subscription.id}, data={
        "planKey": payment.planKey, "billingCycle": payment.billingCycle, "status": "active", "price": payment.amount,
        "currency": payment.currency, "currentPeriodEnd": add_period(start, str(payment.billingCycle)), "cancelAtPeriodEnd": False,
        "startedAt": subscription.startedAt if renewing else now(), **_NO_PENDING,
    })


async def sweep_subscriptions() -> int:
    """Periodic job: moves lapsed subscriptions to their terminal status."""
    return await db.subscription.update_many(
        where={"status": {"in": ["trialing", "active", "past_due"]}, "currentPeriodEnd": {"lt": now()}}, data={"status": "expired"},
    )


async def admin_update_subscription(sub_id: str, patch: dict) -> Any:
    subscription = await db.subscription.find_unique(where={"id": sub_id})
    if not subscription:
        raise not_found("Subscription")
    data: dict[str, Any] = {}
    plan_key, cycle, period_end = str(subscription.planKey), str(subscription.billingCycle), subscription.currentPeriodEnd
    if patch.get("planKey"):
        plan = await db.plan.find_unique(where={"key": patch["planKey"]})
        if not plan:
            raise unprocessable("Unknown plan")
        plan_key = str(plan.key)
        data.update(planKey=plan_key, currency=plan.currency)
    if patch.get("billingCycle"):
        cycle = patch["billingCycle"]
        data["billingCycle"] = cycle
    if patch.get("planKey") or patch.get("billingCycle"):
        plan = await db.plan.find_unique(where={"key": plan_key})
        data["price"] = price_for(plan, cycle)
    if patch.get("status"):
        data["status"] = patch["status"]
    if patch.get("extendDays"):
        period_end = max(now(), period_end) + timedelta(days=patch["extendDays"])
        data["currentPeriodEnd"] = period_end
    if patch.get("status") == "active" and period_end < now():
        raise unprocessable("Extend the period when re-activating an expired subscription", "PERIOD_EXPIRED")
    if not data:
        return subscription
    return await db.subscription.update(where={"id": subscription.id}, data=data)
