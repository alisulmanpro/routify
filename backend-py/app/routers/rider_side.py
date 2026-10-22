"""Smaller rider-facing routers: config, files, routes, rider dashboard, reports, subscriptions."""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Request
from pydantic import Field, StringConstraints, model_validator

from ..auth import authenticate
from ..errors import not_found
from ..http import respond, today_key
from ..security import verify_file_signature
from ..services import auth_service as auth
from ..services import billing
from ..services import report_service as reports
from ..services import rider_dashboard as dash
from ..services import route_service as routes
from ..services import storage_service as storage
from ..services import subscription_service as subs
from ..services.settings_service import get_public_config
from ..validation import DateKey, IdParams, ObjectId, Preference, Schema, validate

# ---------- /config ----------
config_router = APIRouter(prefix="/config")


@config_router.get("")
async def public_config():
    return respond(await get_public_config())


# ---------- /files ----------
files_router = APIRouter(prefix="/files")


@files_router.get("/{kind}/{name}")
async def get_file(request: Request, kind: str, name: str):
    """Files are private. Access needs a short-lived HMAC-signed URL issued by an authenticated API response."""
    key = f"{kind}/{name}"
    q = request.query_params
    disposition = q.get("d")
    if not verify_file_signature(key, q.get("exp"), disposition, q.get("sig")):
        raise not_found("File")
    return await storage.file_response(key, disposition, name, {
        "Content-Disposition": f'{disposition}; filename="{name}"',
        "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin",
    })


# ---------- /routes ----------
routes_router = APIRouter(prefix="/routes")


class Point(Schema):
    latitude: Annotated[float, Field(ge=-90, le=90)]
    longitude: Annotated[float, Field(ge=-180, le=180)]


class BuildBody(Schema):
    preference: Optional[Preference] = None
    origin: Optional[Point] = None
    deliveryIds: Optional[Annotated[list[ObjectId], Field(max_length=300)]] = None
    date: Optional[DateKey] = None
    name: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]] = None


@routes_router.post("/build")
async def build_route(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=BuildBody))["body"]
    return respond(await routes.build(actor, preference=body.preference, origin=body.origin.model_dump() if body.origin else None,
                                      delivery_ids=body.deliveryIds, date=body.date, name=body.name), 201)


class DayQuery(Schema):
    # The rider's local date, so "today" follows their clock rather than the server's (UTC).
    date: Optional[DateKey] = None


@routes_router.get("/current")
async def current_route(request: Request):
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DayQuery))["query"]
    return respond(await routes.get_current(actor, query.date))


@routes_router.get("/upcoming")
async def upcoming_routes(request: Request):
    """Routes planned for later days, e.g. tomorrow's route planned the night before."""
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DayQuery))["query"]
    return respond(await routes.list_upcoming(actor, query.date))


class RangeQuery(Schema):
    # The rider's local dates (YYYY-MM-DD). Without `to`, every route from `from` onwards.
    date_from: DateKey = Field(alias="from")
    to: Optional[DateKey] = None

    @model_validator(mode="after")
    def _ordered(self):
        if self.to is not None and self.to < self.date_from:
            raise ValueError("to: Must be on or after from")
        return self


@routes_router.get("/by-date")
async def routes_by_date(request: Request):
    """All of the rider's routes (any status) for a range of days, as summaries, e.g. for the Home day selector."""
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=RangeQuery))["query"]
    return respond(await routes.list_by_date(actor, query.date_from, query.to))


class DateBody(Schema):
    date: DateKey
    origin: Optional[Point] = None


@routes_router.get("/leftover")
async def left_over_stops(request: Request):
    """Open stops left from days before the rider's today (`date`), for the "move to today?" banner on Home."""
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DayQuery))["query"]
    return respond(await routes.left_over(actor, query.date or today_key()))


@routes_router.post("/carry-over")
async def carry_over_stops(request: Request):
    """Moves those stops to `date` and onto that day's route. Never deletes routes or deliveries."""
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=DateBody))["body"]
    return respond(await routes.carry_over(actor, body.date, origin=body.origin.model_dump() if body.origin else None))


@routes_router.get("")
async def completed_routes(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await routes.list_completed(actor))


@routes_router.post("/{id}/retry-geocoding")
async def retry_geocoding(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(await routes.retry_geocoding(actor, params.id))


class OptimizeBody(Schema):
    origin: Optional[Point] = None


@routes_router.post("/{id}/optimize")
async def optimize_route(request: Request):
    """Re-orders the open stops by road travel time from the rider's position, including newly added stops."""
    actor = await authenticate(request, "rider")
    valid = await validate(request, params=IdParams, body=OptimizeBody)
    body = valid["body"]
    return respond(await routes.optimize(actor, valid["params"].id, origin=body.origin.model_dump() if body.origin else None))


@routes_router.get("/{id}")
async def get_route(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(await routes.get_by_id(actor, params.id))


@routes_router.post("/{id}/start")
async def start_route(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(await routes.start(actor, params.id))


# ---------- /rider ----------
rider_router = APIRouter(prefix="/rider")


class DateQuery(Schema):
    date: Optional[DateKey] = None


@rider_router.get("/dashboard")
async def dashboard(request: Request):
    actor = await authenticate(request, "rider")
    query = (await validate(request, query=DateQuery))["query"]
    return respond(await dash.dashboard(actor, query.date or today_key()))


@rider_router.get("/history")
async def history(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await dash.history(actor))


# The app checks the rider's city on launch and every few hours: preview first, save once the rider agrees.
@rider_router.get("/service-area/detect")
async def detect_area(request: Request):
    await authenticate(request, "rider")
    query = (await validate(request, query=Point))["query"]
    return respond(await auth.preview_service_area(query.model_dump()))


@rider_router.put("/service-area")
async def confirm_area(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=Point))["body"]
    return respond(await auth.confirm_service_area(actor["id"], body.model_dump()))


@rider_router.delete("/history")
async def clear_history(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await dash.clear_history(actor))


# ---------- /reports ----------
reports_router = APIRouter(prefix="/reports")


class GenerateBody(Schema):
    date: Optional[DateKey] = None


@reports_router.post("/generate")
async def generate_report(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=GenerateBody))["body"]
    return respond(await reports.generate(actor, body.date or today_key()), 201)


@reports_router.get("")
async def my_reports(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await reports.list_mine(actor))


@reports_router.get("/{id}")
async def get_report(request: Request):
    actor = await authenticate(request, "rider")
    params = (await validate(request, params=IdParams))["params"]
    return respond(reports.serialize_report(await reports.find_visible(actor, params.id)))


# ---------- /subscriptions ----------
subscriptions_router = APIRouter(prefix="/subscriptions")


class ChangeBody(Schema):
    planKey: Literal["starter", "pro"]
    billingCycle: Literal["monthly", "annual"]


@subscriptions_router.get("/me")
async def my_subscription(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await subs.get_mine(actor))


@subscriptions_router.post("")
async def request_change(request: Request):
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=ChangeBody))["body"]
    return respond(await subs.request_change(actor, body.planKey, body.billingCycle), 201)


@subscriptions_router.post("/cancel")
async def cancel(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await subs.cancel_at_period_end(actor))


# In-app purchases: the app buys through StoreKit / Play Billing, then reports the receipt here for verification.
@subscriptions_router.get("/store")
async def store_config(request: Request):
    actor = await authenticate(request, "rider")
    return respond(await billing.store_config(actor))


class PurchaseBody(Schema):
    store: Literal["apple", "google", "revenuecat", "mock"]
    # apple: the transaction's signed JWS · google: the purchase token · revenuecat, mock: not used
    receipt: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=20_000)]] = None
    productId: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]] = None
    # Mock store only: start with a free trial, as a store free-trial offer would. Real stores report trials themselves.
    trial: bool = False


@subscriptions_router.post("/purchases")
async def report_purchase(request: Request):
    """Also used for "Restore purchases": reporting the same receipt again is harmless."""
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=PurchaseBody))["body"]
    await billing.verify_purchase(actor, body.store, receipt=body.receipt, product_id=body.productId, trial=body.trial)
    return respond(await subs.get_mine(actor))


class MockEventBody(Schema):
    event: Literal["renew", "cancel", "resume", "fail_renewal", "grace", "recover", "expire", "refund"]


@subscriptions_router.post("/mock/events")
async def mock_store_event(request: Request):
    """Test store only (never enabled in production): simulates what the real stores do over time."""
    actor = await authenticate(request, "rider")
    body = (await validate(request, body=MockEventBody))["body"]
    await billing.simulate_mock_event(actor, body.event)
    return respond(await subs.get_mine(actor))

