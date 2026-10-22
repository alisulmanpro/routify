"""Redis, when REDIS_URL is set (P7.2): rate limits, caches and metrics shared by every API process and instance.

Without it (local development) callers fall back to per-process memory or the database, and a Redis outage does the
same: Redis only ever makes things faster or more consistent, never required for the API to answer.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from .config import env
from .logger import log

_client: Any = None
_down_until = 0.0
RETRY_AFTER_SECONDS = 30.0


def client() -> Any | None:
    """The shared client, or None (not configured, or it failed in the last RETRY_AFTER_SECONDS)."""
    global _client
    if not env.REDIS_URL or time.monotonic() < _down_until:
        return None
    if _client is None:
        import redis.asyncio as redis

        _client = redis.from_url(env.REDIS_URL, decode_responses=True, socket_timeout=1.0, socket_connect_timeout=1.0)
    return _client


def failed(what: str) -> None:
    """A Redis call failed: fall back for a while instead of failing (or slowing) every request."""
    global _down_until
    _down_until = time.monotonic() + RETRY_AFTER_SECONDS
    log(logging.WARNING, f"Redis unavailable ({what}); using the local fallback for {int(RETRY_AFTER_SECONDS)} s", exc_info=True)


def key(*parts: str) -> str:
    return env.REDIS_KEY_PREFIX + ":".join(parts)


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
