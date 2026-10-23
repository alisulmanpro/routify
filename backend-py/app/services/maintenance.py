"""Hourly housekeeping (P7.3): one scheduler for every instance. The worker queues one "maintenance" job per hour with a
unique dedupKey, so with several workers (or none of the API instances) it still runs exactly once an hour."""
from __future__ import annotations

import logging
from datetime import timedelta

from ..db import db
from ..http import now
from ..logger import log
from . import alerts, jobs


async def run_maintenance() -> None:
    """Expire lapsed subscriptions and drop stale cache/token rows (MongoDB did the latter with TTL indexes)."""
    from .subscription_service import sweep_subscriptions

    expired = await sweep_subscriptions()
    if expired:
        log(logging.INFO, "Expired lapsed subscriptions", expired=expired)
    await db.geocodecache.delete_many(where={"expiresAt": {"lt": now()}})
    await db.refreshtoken.delete_many(where={"expiresAt": {"lt": now() - timedelta(days=7)}})
    await db.passwordreset.delete_many(where={"expiresAt": {"lt": now() - timedelta(days=1)}})
    await db.ratelimit.delete_many(where={"resetAt": {"lt": now()}, "OR": [{"lockedUntil": None}, {"lockedUntil": {"lt": now()}}]})
    await db.idempotencykey.delete_many(where={"expiresAt": {"lt": now()}})
    await db.requestminute.delete_many(where={"minute": {"lt": now() - timedelta(days=7)}})
    await jobs.delete_old()


@jobs.handler("maintenance")
async def _maintenance_job(_payload: dict) -> None:
    await run_maintenance()


async def schedule() -> None:
    """Called by every worker about once a minute; only the first one queues this hour's run."""
    hour = now().strftime("%Y-%m-%dT%H")
    if await jobs.schedule_once("maintenance", f"maintenance:{hour}"):
        log(logging.INFO, "Queued hourly maintenance", hour=hour)
    await alerts.schedule()  # every 5 minutes, when ALERT_WEBHOOK_URL is set (P7.6)
