"""SaaS subscription payments only, always billed directly to the rider; customer COD money never touches this table."""
from __future__ import annotations

import asyncio
from typing import Any

from ..db import db
from ..errors import conflict, not_found, unprocessable
from ..http import now
from ..ids import new_id
from .subscription_service import apply_succeeded_payment

TRANSITIONS = {"pending": ["succeeded", "failed"], "succeeded": ["refunded"], "failed": [], "refunded": []}


async def record_manual(*, user_id: str, plan_key: str, billing_cycle: str, amount: float | None = None, currency: str | None = None,
                        status: str = "succeeded", provider_ref: str | None = None) -> Any:
    rider, plan, subscription = await asyncio.gather(
        db.user.find_first(where={"id": user_id, "role": "rider"}),
        db.plan.find_unique(where={"key": plan_key}),
        db.subscription.find_unique(where={"userId": user_id}),
    )
    if not rider:
        raise not_found("Rider")
    if not plan or plan.key == "trial":
        raise unprocessable("Choose a paid plan")
    payment = await db.payment.create(data={
        "id": new_id(), "userId": user_id, "subscriptionId": subscription.id if subscription else None, "planKey": plan_key,
        "billingCycle": billing_cycle, "amount": amount if amount is not None else (plan.annualPrice if billing_cycle == "annual" else plan.monthlyPrice),
        "currency": currency or plan.currency, "status": "pending", "provider": "manual", "providerRef": provider_ref or None,
    })
    return payment if status == "pending" else await set_status(payment.id, status)


async def set_status(payment_id: str, nxt: str) -> Any:
    payment = await db.payment.find_unique(where={"id": payment_id})
    if not payment:
        raise not_found("Payment")
    current = str(payment.status)
    if current == nxt:
        return payment
    if nxt not in TRANSITIONS[current]:
        raise conflict(f"A {current} payment cannot become {nxt}", "INVALID_STATE")

    data: dict[str, Any] = {"status": nxt}
    if nxt == "succeeded":
        data["paidAt"] = now()
    payment = await db.payment.update(where={"id": payment.id}, data=data)

    if nxt == "succeeded":
        await apply_succeeded_payment(payment)
    if nxt == "failed":
        await db.subscription.update_many(
            where={"userId": payment.userId, "pendingPaymentId": payment.id},
            data={"pendingPlanKey": None, "pendingBillingCycle": None, "pendingPaymentId": None},
        )
    return payment
