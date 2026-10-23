"""Request metrics per API process (P7.6): requests, 5xx errors and a latency histogram per minute.

Counted in memory (no work per request beyond a few additions) and written to request_minutes once a minute, so the
worker's alerts see every process and instance without Redis. p95 is read from the histogram: the upper bound of the
bucket that holds the 95th percentile.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from bisect import bisect_left
from datetime import UTC, datetime

from .db import db
from .logger import log

BUCKETS_MS = (25, 50, 100, 150, 250, 500, 800, 1000, 2000, 5000)  # plus one bucket for slower requests
FLUSH_SECONDS = 60
UNTRACKED_PATHS = {"/health", "/ready"}
INSTANCE = f"{socket.gethostname()}:{os.getpid()}"[:64]

# minute -> [requests, errors, buckets...]
_minutes: dict[datetime, list[int]] = {}


def _minute(at: datetime | None = None) -> datetime:
    return (at or datetime.now(UTC)).replace(second=0, microsecond=0, tzinfo=None)


def record(path: str, status: int, ms: float) -> None:
    if path in UNTRACKED_PATHS:
        return
    row = _minutes.setdefault(_minute(), [0, 0] + [0] * (len(BUCKETS_MS) + 1))
    row[0] += 1
    row[1] += status >= 500
    row[2 + bisect_left(BUCKETS_MS, ms)] += 1


_UPSERT = """
INSERT INTO "request_minutes" ("minute", "instance", "requests", "errors", "buckets") VALUES ($1::timestamp, $2, $3, $4, $5::jsonb)
ON CONFLICT ("minute", "instance") DO UPDATE SET "requests" = EXCLUDED."requests", "errors" = EXCLUDED."errors", "buckets" = EXCLUDED."buckets"
"""


async def flush(*, everything: bool = False) -> int:
    """Writes the finished minutes (all of them when stopping). A minute kept in memory is rewritten whole, so a retry
    after a failed write is harmless. Returns the minutes written."""
    now = _minute()
    written = 0
    for minute in sorted(_minutes):
        if minute >= now and not everything:
            continue
        row = _minutes[minute]
        await db.execute_raw(_UPSERT, minute.isoformat(), INSTANCE, row[0], row[1], json.dumps(row[2:]))
        del _minutes[minute]
        written += 1
    return written


async def run_flusher(stop: asyncio.Event) -> None:
    """The API process's flush loop (started in the app's lifespan)."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=FLUSH_SECONDS)
        except TimeoutError:
            pass
        try:
            await flush(everything=stop.is_set())
        except Exception:  # noqa: BLE001 - kept in memory and written next time
            log(logging.WARNING, "Could not save request metrics", exc_info=True)


def percentile_ms(buckets: list[int], share: float = 0.95) -> int | None:
    """The upper bound (ms) of the bucket holding the `share` percentile; None without requests. Above the last bound,
    twice the last bound is reported (at least that slow)."""
    total = sum(buckets)
    if not total:
        return None
    rank, seen = share * total, 0
    for i, n in enumerate(buckets):
        seen += n
        if seen >= rank:
            return BUCKETS_MS[i] if i < len(BUCKETS_MS) else BUCKETS_MS[-1] * 2
    return BUCKETS_MS[-1] * 2


def reset_for_tests() -> None:
    _minutes.clear()
