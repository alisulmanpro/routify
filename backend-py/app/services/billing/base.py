"""What every store adapter produces: one normalized view of a store subscription, plus the shared catalog helpers."""
from __future__ import annotations

import hashlib
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from ...config import env
from ...errors import AppError

# active: paid up · grace: renewal failed but the store keeps access open · past_due: store is retrying, no access
# expired: ended or cancelled and run out · revoked: refunded or revoked by the store
ACCESS_STATUSES = ("active", "grace")
LIVE_STATUSES = ("active", "grace", "past_due")


@dataclass
class StoreState:
    store: str                      # apple | google | mock
    purchase_key: str               # Apple originalTransactionId / Google purchaseToken / mock id
    product_id: str                 # catalog id: Apple productId, Google "productId:basePlanId", mock "plan.cycle"
    status: str
    expires_at: datetime
    auto_renew: bool
    environment: str                # production | sandbox | mock
    event_at: datetime              # when the store produced this state (orders out-of-sequence events)
    transaction_id: str | None = None   # id of the paid billing period, once per renewal
    price: float | None = None
    currency: str | None = None
    account_token: str | None = None    # the app account the purchase was made for, if the app set one
    linked_key: str | None = None       # Google: the purchase token this one replaced (upgrade/downgrade/resubscribe)
    trial: bool = False                 # in a store-run free trial: access now, nothing charged yet

    @property
    def test_mode(self) -> bool:
        return self.environment != "production"


def billing_error(status: int, code: str, message: str) -> AppError:
    return AppError(status, code, message)


def invalid_receipt(message: str = "The purchase could not be verified with the store.") -> AppError:
    return AppError(422, "INVALID_RECEIPT", message)


STORE_LABELS = {"apple": "the App Store", "google": "Google Play", "revenuecat": "RevenueCat", "mock": "the test store"}


def store_unavailable(store: str) -> AppError:
    return AppError(503, "STORE_UNAVAILABLE", f"Could not reach {STORE_LABELS.get(store, store)}. Please try again shortly.")


def account_token(user_id: str) -> str:
    """A stable, unguessable UUID per rider. The app passes it to the store at purchase time
    (Apple appAccountToken / Google obfuscatedAccountId), so a receipt can only ever activate the account that bought it."""
    digest = hmac.new(env.JWT_REFRESH_SECRET.encode(), f"store-account:{user_id}".encode(), hashlib.sha256).digest()
    return str(uuid.UUID(bytes=digest[:16], version=4))


def from_millis(value: int | str | None) -> datetime | None:
    return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc) if value not in (None, "") else None


def from_rfc3339(value: str | None) -> datetime | None:
    """Google timestamps carry up to nanoseconds ("2026-01-01T10:00:00.123456789Z"); Python reads at most microseconds."""
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    if "." in text:
        head, rest = text.split(".", 1)
        digits = "".join(ch for ch in rest if ch.isdigit())
        text = f"{head}.{digits[:6].ljust(6, '0')}{rest[len(digits):]}"
    return datetime.fromisoformat(text).astimezone(timezone.utc)


def mock_product_id(plan: str, cycle: str) -> str:
    return f"{plan}.{cycle}"


def catalog(settings: dict, store: str) -> dict[str, tuple[str, str]]:
    """product id -> (plan key, billing cycle) for one store."""
    out: dict[str, tuple[str, str]] = {}
    for plan, cycles in (settings.get("billing", {}).get("products") or {}).items():
        for cycle, ids in (cycles or {}).items():
            product = mock_product_id(plan, cycle) if store == "mock" else (ids or {}).get(store)
            if product:
                out.setdefault(product, (plan, cycle))
    return out
