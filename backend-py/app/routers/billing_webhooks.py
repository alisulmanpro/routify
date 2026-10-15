"""Server-to-server notifications from the App Store and Google Play. Public routes: each request is authenticated by
the store's own signature (Apple JWS chain / Google OIDC token), never by a user session."""
from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Request
from pydantic import StringConstraints

from ..http import respond
from ..services import billing
from ..validation import Schema, validate

router = APIRouter(prefix="/billing/webhooks")


class AppleNotification(Schema):
    signedPayload: Annotated[str, StringConstraints(min_length=10, max_length=200_000)]


class PubSubMessage(Schema):
    data: Annotated[str, StringConstraints(max_length=100_000)]
    messageId: Optional[str] = None


class PubSubPush(Schema):
    message: PubSubMessage
    subscription: Optional[str] = None


class RevenueCatEvent(Schema):
    event: dict[str, Any]
    api_version: Optional[str] = None


@router.post("/apple")
async def apple_notification(request: Request):
    """App Store Server Notifications V2. Any non-2xx answer makes Apple retry later."""
    body = (await validate(request, body=AppleNotification))["body"]
    await billing.handle_apple_webhook(body.signedPayload)
    return respond({"received": True})


@router.post("/google")
async def google_notification(request: Request):
    """Real-time Developer Notifications via a Pub/Sub push subscription. Non-2xx answers are redelivered."""
    body = (await validate(request, body=PubSubPush))["body"]
    await billing.handle_google_webhook(request.headers.get("authorization"), body.model_dump())
    return respond({"received": True})


@router.post("/revenuecat")
async def revenuecat_notification(request: Request):
    """RevenueCat webhooks (authenticated by the Authorization value set in its dashboard). Non-2xx answers are retried."""
    body = (await validate(request, body=RevenueCatEvent))["body"]
    await billing.handle_revenuecat_webhook(request.headers.get("authorization"), body.event)
    return respond({"received": True})

