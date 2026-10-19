from __future__ import annotations

import copy
import time
from typing import Any

from ..db import as_json, db
from ..ids import new_id

DEFAULT_SETTINGS: dict[str, Any] = {
    "currencies": ["USD", "GBP", "EUR", "PKR", "INR"],
    "defaultCurrency": "USD",
    # Length of the free trial offered through the stores (7, 14 or 30 days). The stores run the trial and need a card.
    "trialDays": 14,
    "route": {"defaultPreference": "smart", "avgSpeedKmh": 25, "stopServiceMinutes": 3},
    "reports": {"includePhotos": True},
    "platform": {"name": "Routify", "supportEmail": "", "privacyUrl": "", "paymentInstructions": ""},
    "security": {"minPasswordLength": 8, "maxFailedLogins": 5, "lockoutMinutes": 15},
    # Store product IDs per plan and billing cycle. They must match App Store Connect / Play Console exactly.
    # Google subscriptions are "<productId>:<basePlanId>". The mock store uses "<plan>.<cycle>".
    "billing": {"products": {
        "starter": {"monthly": {"apple": "routify.starter.monthly", "google": "routify_starter:monthly"},
                    "annual": {"apple": "routify.starter.annual", "google": "routify_starter:annual"}},
        "pro": {"monthly": {"apple": "routify.pro.monthly", "google": "routify_pro:monthly", "revenuecat": "monthly"},
                "annual": {"apple": "routify.pro.annual", "google": "routify_pro:annual", "revenuecat": "yearly"}},
    }},
}

_cache: dict | None = None
_cached_at = 0.0
TTL_SECONDS = 15


def merge(base: dict, patch: dict | None) -> dict:
    out = copy.deepcopy(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            out[key] = merge(base[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


async def get_settings() -> dict:
    global _cache, _cached_at
    if _cache is not None and time.monotonic() - _cached_at < TTL_SECONDS:
        return _cache
    row = await db.setting.find_unique(where={"key": "platform"})
    _cache = merge(DEFAULT_SETTINGS, row.value if row and isinstance(row.value, dict) else None)
    _cached_at = time.monotonic()
    return _cache


async def update_settings(patch: dict) -> dict:
    global _cache, _cached_at
    nxt = merge(await get_settings(), patch)
    await db.setting.upsert(
        where={"key": "platform"},
        data={"create": {"id": new_id(), "key": "platform", "value": as_json(nxt)}, "update": {"value": as_json(nxt)}},
    )
    _cache = nxt
    _cached_at = time.monotonic()
    return nxt


async def get_public_config() -> dict:
    """What the mobile app may know before login."""
    s = await get_settings()
    return {
        "routePreference": s["route"]["defaultPreference"],
        "minPasswordLength": s["security"]["minPasswordLength"],
        "platformName": s["platform"]["name"],
        "supportEmail": s["platform"]["supportEmail"],
        "privacyUrl": s["platform"]["privacyUrl"],
        "paymentInstructions": s["platform"]["paymentInstructions"],
        "trialDays": s["trialDays"],
    }


def reset_settings_cache() -> None:
    global _cache
    _cache = None
