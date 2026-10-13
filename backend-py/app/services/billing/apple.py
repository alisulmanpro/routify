"""App Store (StoreKit 2) verification using Apple's official app-store-server-library.

The app sends the purchase's signed transaction (JWS). Its certificate chain is checked up to Apple's root CA
(bundled in app/certs/apple), so nothing the client says is trusted. Renewals, cancellations and refunds arrive as
App Store Server Notifications V2 at /api/v1/billing/webhooks/apple.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from appstoreserverlibrary.models.Environment import Environment
from appstoreserverlibrary.signed_data_verifier import SignedDataVerifier, VerificationException, VerificationStatus

from ...config import env
from ...http import now
from ...logger import log
from .base import StoreState, from_millis, invalid_receipt

CERT_DIR = Path(__file__).resolve().parents[2] / "certs" / "apple"
_verifiers: dict[str, SignedDataVerifier] = {}


def _verifier(environment: str) -> SignedDataVerifier:
    if environment not in _verifiers:
        roots = [p.read_bytes() for p in sorted(CERT_DIR.glob("*.cer"))]
        production = environment == "production"
        _verifiers[environment] = SignedDataVerifier(
            roots, enable_online_checks=env.is_production, environment=Environment.PRODUCTION if production else Environment.SANDBOX,
            bundle_id=env.APPLE_BUNDLE_ID, app_apple_id=env.APPLE_APP_ID if production else None,
        )
    return _verifiers[environment]


def _decode(method: str, payload: str) -> Any:
    """Tries the configured environment first. A production server also accepts sandbox data, because App Review
    tests purchases in the sandbox against the production server (Apple's own guidance)."""
    order = ["production", "sandbox"] if env.APPLE_ENVIRONMENT == "production" else ["sandbox"]
    for i, environment in enumerate(order):
        try:
            return getattr(_verifier(environment), method)(payload)
        except VerificationException as error:
            if error.status == VerificationStatus.INVALID_ENVIRONMENT and i + 1 < len(order):
                continue
            log(logging.WARNING, "App Store signature rejected", status=str(error.status))
            raise invalid_receipt() from None
        except Exception:  # noqa: BLE001 - malformed JWS and the like
            raise invalid_receipt() from None
    raise invalid_receipt()


def _state(tx: Any, renewal: Any | None, event_at: Any) -> StoreState:
    at = now()
    expires = from_millis(tx.expiresDate)
    if not tx.originalTransactionId or not tx.productId or not expires:
        raise invalid_receipt("This purchase is not a Routify subscription.")
    auto_renew = True if renewal is None else renewal.rawAutoRenewStatus == 1
    grace_end = from_millis(getattr(renewal, "gracePeriodExpiresDate", None)) if renewal else None
    if tx.revocationDate:
        status = "revoked"
    elif expires > at:
        status = "active"
    elif grace_end and grace_end > at:
        status, expires = "grace", grace_end
    elif renewal is not None and renewal.isInBillingRetryPeriod:
        status = "past_due"
    else:
        status = "expired"
    environment = (tx.rawEnvironment or "Sandbox").lower()
    return StoreState(
        store="apple", purchase_key=str(tx.originalTransactionId), product_id=tx.productId, status=status, expires_at=expires,
        auto_renew=auto_renew, environment="production" if environment == "production" else "sandbox", event_at=event_at or at,
        transaction_id=str(tx.transactionId) if tx.transactionId else None,
        price=tx.price / 1000 if tx.price is not None else None, currency=tx.currency,
        account_token=str(tx.appAccountToken).lower() if tx.appAccountToken else None,
        trial=getattr(tx, "rawOfferDiscountType", None) == "FREE_TRIAL",
    )


async def verify_transaction(signed_transaction: str) -> StoreState:
    tx = await asyncio.to_thread(_decode, "verify_and_decode_signed_transaction", signed_transaction)
    if tx.isUpgraded:
        raise invalid_receipt("This purchase was replaced by a newer plan. Restore purchases to load the current one.")
    return _state(tx, None, from_millis(tx.signedDate))


async def handle_notification(signed_payload: str) -> StoreState | None:
    """Returns the subscription's new state, or None for notifications that carry no subscription change."""
    note = await asyncio.to_thread(_decode, "verify_and_decode_notification", signed_payload)
    data = note.data
    if note.rawNotificationType == "TEST" or not data or not data.signedTransactionInfo:
        return None
    tx = await asyncio.to_thread(_decode, "verify_and_decode_signed_transaction", data.signedTransactionInfo)
    renewal = await asyncio.to_thread(_decode, "verify_and_decode_renewal_info", data.signedRenewalInfo) if data.signedRenewalInfo else None
    state = _state(tx, renewal, from_millis(note.signedDate))
    if note.rawNotificationType in ("REFUND", "REVOKE"):
        state.status, state.auto_renew = "revoked", False
    return state
