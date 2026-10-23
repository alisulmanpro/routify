"""Counts Google Maps Platform calls per day, rider and API (P5.6), into google_usage.

The rider comes from the request (authenticate() sets it), so code deep in the geocoder needs no extra argument."""
from __future__ import annotations

import logging
from contextvars import ContextVar

from ..db import db
from ..http import today_key
from ..logger import log

current_rider: ContextVar[str | None] = ContextVar("current_rider", default=None)

_UPSERT = """
INSERT INTO "google_usage" ("day", "riderId", "api", "calls") VALUES ($1, $2, $3, $4)
ON CONFLICT ("day", "riderId", "api") DO UPDATE SET "calls" = "google_usage"."calls" + EXCLUDED."calls"
"""


async def record(api: str, calls: int = 1) -> None:
    """Never raises: counting must not break a lookup."""
    try:
        await db.execute_raw(_UPSERT, today_key(), current_rider.get() or "-", api, calls)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Could not count a Google call", api=api, exc_info=True)


async def usage(day_from: str, day_to: str, rider_id: str | None = None) -> list[dict]:
    """Calls per day and API (and rider, unless one is given), for the admin console."""
    where: dict = {"day": {"gte": day_from, "lte": day_to}} | ({"riderId": rider_id} if rider_id else {})
    rows = await db.googleusage.find_many(where=where, order=[{"day": "asc"}, {"api": "asc"}])
    return [{"day": r.day, "riderId": None if r.riderId == "-" else r.riderId, "api": r.api, "calls": r.calls} for r in rows]
