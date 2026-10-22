"""The stop event history (stop_events): every arrive / deliver / fail a rider sent, applied or not."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from ..db import db
from ..http import now
from ..ids import new_id

# A phone's clock may be a little ahead; an event "from the future" counts as now. Older than this is refused.
MAX_FUTURE = timedelta(minutes=5)
MAX_AGE = timedelta(days=7)


def event_time(at: datetime | None) -> datetime:
    """When the event happened by the phone's clock, kept within sane bounds (None = now)."""
    current = now()
    if at is not None and at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    if at is None or at > current + MAX_FUTURE:
        return current
    return max(at, current - MAX_AGE)


async def record(stop: Any, kind: str, outcome: str, to_status: str, *, at: datetime, source: str, reason: str | None = None,
                 note: str | None = None, idempotency_key: str | None = None, client: Any = db) -> None:
    await client.stopevent.create(data={
        "id": new_id(), "riderId": stop.riderId, "deliveryId": stop.id, "routeId": stop.routeId, "type": kind, "outcome": outcome,
        "fromStatus": str(stop.status), "toStatus": to_status, "reason": reason, "note": note, "at": at, "source": source,
        "idempotencyKey": idempotency_key,
    })
