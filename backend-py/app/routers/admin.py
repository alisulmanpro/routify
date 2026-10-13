from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from fastapi import APIRouter, Request
from pydantic import Field, StringConstraints, field_validator, model_validator

from ..auth import authenticate
from ..http import ApiJSONResponse, respond
from ..services import admin_service as admin
from ..services import delivery_service as deliveries
from ..services import payment_service as payments
from ..services.audit_service import audit
from ..services.settings_service import get_settings, update_settings
from ..services.subscription_service import admin_update_subscription, serialize_subscription
from ..validation import Currency, DateKey, Email, IdParams, Money, ObjectId, Pagination, Preference, Schema, Trimmed, validate

router = APIRouter(prefix="/admin")

Search = Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]]
SubStatus = Literal["inactive", "trialing", "active", "past_due", "expired", "cancelled"]
PlanKey = Literal["trial", "starter", "pro"]
Cycle = Literal["monthly", "annual"]


class NotEmpty(Schema):
    @model_validator(mode="after")
    def not_empty(self):
        if not self.model_fields_set:
            raise ValueError("Nothing to update")
        return self


async def _admin(request: Request) -> dict:
    return await authenticate(request, "owner_admin")


async def _log(request: Request, action: str, target_type: str, target_id, meta) -> None:
    await audit(request.state.user, action, target_type=target_type, target_id=target_id, meta=meta, ip=request.state.ip)


class OverviewQuery(Schema):
    days: Optional[int] = None

    @field_validator("days")
    @classmethod
    def seven_or_thirty(cls, v):
        if v is not None and v not in (7, 30):
            raise ValueError("Invalid input")
        return v


@router.get("/overview")
async def overview(request: Request):
    await _admin(request)
    query = (await validate(request, query=OverviewQuery))["query"]
    return respond(await admin.overview(query.days or 7))


# Riders: every rider is an independent account that signs up, subscribes and runs their own deliveries.
class RidersQuery(Pagination):
    search: Search = None
    status: Optional[Literal["active", "suspended"]] = None


class RiderPatch(Schema):
    status: Literal["active", "suspended"]


@router.get("/riders")
async def riders(request: Request):
    await _admin(request)
    query = (await validate(request, query=RidersQuery))["query"]
    items, meta = await admin.list_riders(query.provided())
    return respond(items, meta=meta)


@router.patch("/riders/{id}")
async def update_rider(request: Request):
    await _admin(request)
    valid = await validate(request, params=IdParams, body=RiderPatch)
    body = valid["body"].provided()
    updated = await admin.update_rider(valid["params"].id, body)
    await _log(request, "rider.update", "user", updated["id"], body)
    return respond(updated)


# Deliveries
class DeliveriesQuery(Pagination):
    dateFrom: Optional[DateKey] = None
    dateTo: Optional[DateKey] = None
    search: Search = None
    date: Optional[DateKey] = None
    status: Optional[Literal["pending", "in_progress", "delivered", "failed"]] = None
    riderId: Optional[ObjectId] = None


@router.get("/deliveries")
async def list_deliveries(request: Request):
    actor = await _admin(request)
    query = (await validate(request, query=DeliveriesQuery))["query"]
    items, meta = await deliveries.list_deliveries(actor, query.provided())
    return respond(await admin.decorate_deliveries(items), meta=meta)


@router.get("/deliveries/{id}")
async def get_delivery(request: Request):
    actor = await _admin(request)
    params = (await validate(request, params=IdParams))["params"]
    delivery = await deliveries.find_visible(actor, params.id)
    return respond((await admin.decorate_deliveries([delivery]))[0])


# Reports
class ReportsQuery(Pagination):
    dateFrom: Optional[DateKey] = None
    dateTo: Optional[DateKey] = None
    search: Search = None
    riderId: Optional[ObjectId] = None


@router.get("/reports")
async def list_reports(request: Request):
    await _admin(request)
    query = (await validate(request, query=ReportsQuery))["query"]
    items, meta = await admin.list_reports(query.provided())
    return respond(items, meta=meta)


# Subscriptions, plans and payments: always billed directly to the rider.
class SubscriptionsQuery(Pagination):
    search: Search = None
    status: Optional[SubStatus] = None
    planKey: Optional[PlanKey] = None
    billingCycle: Optional[Cycle] = None


class SubscriptionPatch(NotEmpty):
    status: Optional[SubStatus] = None
    planKey: Optional[PlanKey] = None
    billingCycle: Optional[Cycle] = None
    extendDays: Optional[Annotated[int, Field(ge=1, le=3660)]] = None


@router.get("/subscriptions")
async def list_subscriptions(request: Request):
    await _admin(request)
    query = (await validate(request, query=SubscriptionsQuery))["query"]
    items, meta = await admin.list_subscriptions(query.provided())
    return respond(items, meta=meta)


@router.patch("/subscriptions/{id}")
async def update_subscription(request: Request):
    await _admin(request)
    valid = await validate(request, params=IdParams, body=SubscriptionPatch)
    body = valid["body"].provided()
    updated = serialize_subscription(await admin_update_subscription(valid["params"].id, body))
    await _log(request, "subscription.update", "subscription", updated["id"], body)
    return respond(updated)


@router.get("/plans")
async def list_plans(request: Request):
    await _admin(request)
    return respond(await admin.list_plans())


class PlanParams(Schema):
    key: PlanKey


class PlanLimits(Schema):
    deliveriesPerMonth: Optional[Annotated[int, Field(ge=0)]] = None
    reportsPerMonth: Optional[Annotated[int, Field(ge=0)]] = None


class PlanPatch(NotEmpty):
    name: Optional[Trimmed(2, 60)] = None
    monthlyPrice: Optional[Money] = None
    annualPrice: Optional[Money] = None
    currency: Optional[Currency] = None
    active: Optional[bool] = None
    features: Optional[Annotated[list[Trimmed(1, 120)], Field(max_length=20)]] = None
    limits: Optional[PlanLimits] = None


@router.patch("/plans/{key}")
async def update_plan(request: Request):
    await _admin(request)
    valid = await validate(request, params=PlanParams, body=PlanPatch)
    body = valid["body"].provided()
    updated = await admin.update_plan(valid["params"].key, body)
    await _log(request, "plan.update", "plan", updated["key"], body)
    return respond(updated)


class PaymentsQuery(Pagination):
    search: Search = None
    status: Optional[Literal["pending", "succeeded", "failed", "refunded"]] = None
    riderId: Optional[ObjectId] = None


class PaymentBody(Schema):
    riderId: ObjectId
    planKey: Literal["starter", "pro"]
    billingCycle: Cycle
    amount: Optional[Money] = None
    currency: Optional[Currency] = None
    status: Optional[Literal["pending", "succeeded"]] = None
    providerRef: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]] = None


class PaymentPatch(Schema):
    status: Literal["succeeded", "failed", "refunded"]


@router.get("/payments")
async def list_payments(request: Request):
    await _admin(request)
    query = (await validate(request, query=PaymentsQuery))["query"]
    items, meta, totals = await admin.list_payments(query.provided())
    return ApiJSONResponse({"success": True, "data": items, "totals": totals, "meta": meta})


@router.post("/payments")
async def record_payment(request: Request):
    await _admin(request)
    body = (await validate(request, body=PaymentBody))["body"]
    payment = await payments.record_manual(
        user_id=body.riderId, plan_key=body.planKey, billing_cycle=body.billingCycle, amount=body.amount, currency=body.currency,
        status=body.status or "succeeded", provider_ref=body.providerRef,
    )
    await _log(request, "payment.record", "payment", payment.id, {"status": str(payment.status), "amount": payment.amount, "currency": payment.currency})
    return respond(admin.serialize_payment(payment), 201)


@router.patch("/payments/{id}")
async def update_payment(request: Request):
    await _admin(request)
    valid = await validate(request, params=IdParams, body=PaymentPatch)
    body = valid["body"].provided()
    payment = await payments.set_status(valid["params"].id, body["status"])
    await _log(request, "payment.update", "payment", payment.id, body)
    return respond(admin.serialize_payment(payment))


# Settings + audit
class RouteSettings(Schema):
    defaultPreference: Optional[Preference] = None
    avgSpeedKmh: Optional[Annotated[float, Field(ge=5, le=120)]] = None
    stopServiceMinutes: Optional[Annotated[float, Field(ge=0, le=60)]] = None


class ReportSettings(Schema):
    includePhotos: Optional[bool] = None


class PlatformSettings(Schema):
    name: Optional[Trimmed(1, 80)] = None
    supportEmail: Optional[Union[Literal[""], Email]] = None
    privacyUrl: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]] = None
    paymentInstructions: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]] = None

    @field_validator("privacyUrl")
    @classmethod
    def http_url(cls, v):
        from urllib.parse import urlparse

        if v in (None, ""):
            return v
        parsed = urlparse(v)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Invalid URL")
        return v


class SecuritySettings(Schema):
    minPasswordLength: Optional[Annotated[int, Field(ge=6, le=64)]] = None
    maxFailedLogins: Optional[Annotated[int, Field(ge=3, le=20)]] = None
    lockoutMinutes: Optional[Annotated[int, Field(ge=1, le=1440)]] = None


class StoreProductIds(Schema):
    apple: Optional[Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9._-]{1,200}$")]] = None
    google: Optional[Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z0-9_.]{1,100}:[a-z0-9-]{1,63}$")]] = None


class CycleProducts(Schema):
    monthly: Optional[StoreProductIds] = None
    annual: Optional[StoreProductIds] = None


class ProductCatalog(Schema):
    starter: Optional[CycleProducts] = None
    pro: Optional[CycleProducts] = None


class BillingSettings(Schema):
    products: Optional[ProductCatalog] = None


class SettingsBody(NotEmpty):
    currencies: Optional[Annotated[list[Currency], Field(min_length=1)]] = None
    defaultCurrency: Optional[Currency] = None
    # Free-trial length for store subscriptions. Match it in Play Console (offer free-trial-<days>d) and App Store Connect.
    trialDays: Optional[Literal[7, 14, 30]] = None
    route: Optional[RouteSettings] = None
    reports: Optional[ReportSettings] = None
    platform: Optional[PlatformSettings] = None
    security: Optional[SecuritySettings] = None
    billing: Optional[BillingSettings] = None


@router.get("/settings")
async def get_platform_settings(request: Request):
    await _admin(request)
    return respond(await get_settings())


@router.put("/settings")
async def put_platform_settings(request: Request):
    await _admin(request)
    body = (await validate(request, body=SettingsBody))["body"].provided()
    updated = await update_settings(body)
    await _log(request, "settings.update", "settings", "platform", body)
    return respond(updated)


class AuditQuery(Pagination):
    dateFrom: Optional[DateKey] = None
    dateTo: Optional[DateKey] = None
    search: Search = None
    action: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]] = None
    status: Optional[Literal["success", "failure"]] = None


@router.get("/audit-logs")
async def audit_logs(request: Request):
    await _admin(request)
    query = (await validate(request, query=AuditQuery))["query"]
    items, meta = await admin.list_audit_logs(query.provided())
    return respond(items, meta=meta)
