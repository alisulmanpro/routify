"""P7.6: request metrics per minute, and the alerts the worker sends from them (error rate, p95, queue, Google spend)."""
from __future__ import annotations

import json
from datetime import timedelta

import pytest

from app import metrics
from app.config import env
from app.db import db
from app.http import now, today_key
from app.services import alerts, jobs


@pytest.fixture
def webhook():
    """A configured ALERT_WEBHOOK_URL (env is frozen; the billing tests set it the same way)."""
    object.__setattr__(env, "ALERT_WEBHOOK_URL", "http://alerts.invalid/hook")
    yield
    object.__setattr__(env, "ALERT_WEBHOOK_URL", "")


def test_p95_comes_from_the_histogram():
    assert metrics.percentile_ms([0] * 11) is None
    assert metrics.percentile_ms([95, 5] + [0] * 9) == 25
    assert metrics.percentile_ms([90, 0, 0, 0, 10] + [0] * 6) == 250
    assert metrics.percentile_ms([0] * 10 + [1]) == 10_000


async def test_requests_are_counted_per_minute_and_saved(client):
    metrics.reset_for_tests()
    await client.get("/health")  # not counted
    await client.get("/api/v1/nothing-here")
    row = metrics._minutes[metrics._minute()]
    assert row[0] == 1 and row[1] == 0 and sum(row[2:]) == 1
    assert await metrics.flush() == 0, "the minute in progress stays in memory"
    assert await metrics.flush(everything=True) == 1
    saved = await db.requestminute.find_first(where={"instance": metrics.INSTANCE}, order={"minute": "desc"})
    assert saved.requests >= 1 and len(saved.buckets) == len(metrics.BUCKETS_MS) + 1


async def _minute_row(requests: int, errors: int, buckets: list[int], instance: str) -> None:
    minute = now().replace(second=0, microsecond=0, tzinfo=None)
    await db.execute_raw('INSERT INTO "request_minutes" VALUES ($1::timestamp, $2, $3, $4, $5::jsonb)', minute.isoformat(), instance, requests, errors,
                         json.dumps(buckets))


async def test_alerts_fire_for_errors_slowness_backlog_and_google_spend(client, monkeypatch, webhook):
    await db.requestminute.delete_many()
    assert ("errors" not in {k for k, _ in await alerts.check()})
    # 100 requests: 10 % 5xx and most of them slower than 2 s.
    await _minute_row(100, 10, [10] + [0] * 8 + [90, 0], "test-a")
    await db.googleusage.create(data={"day": today_key(), "riderId": "-", "api": "places_text_search", "calls": 1000})  # ≈ $32
    old = await jobs.enqueue("send_email", {"to": "x"})
    await db.job.update(where={"id": old.id}, data={"createdAt": now() - timedelta(minutes=5), "runAfter": now() + timedelta(seconds=0)})
    try:
        kinds = {k for k, _ in await alerts.check()}
        assert {"errors", "p95", "google"} <= kinds
        # Sent once per kind and hour, whatever number of checks or workers.
        posted: list[str] = []

        async def fake_send(payload):
            posted.append(payload["text"])

        monkeypatch.setitem(jobs.HANDLERS, "alert_notice", fake_send)
        await db.job.delete_many(where={"dedupKey": {"startswith": "alert:"}})
        first = await jobs.HANDLERS["alerts"]({})
        again = await jobs.HANDLERS["alerts"]({})
        assert {"errors", "p95", "google"} <= set(first) and again == []
        await jobs.wait_idle(("alert_notice",))
        assert any("API errors" in t for t in posted) and any("Google Maps" in t for t in posted)
    finally:
        await db.job.delete_many(where={"OR": [{"id": old.id}, {"dedupKey": {"startswith": "alert:"}}]})
        await db.googleusage.delete_many(where={"riderId": "-", "api": "places_text_search"})
        await db.requestminute.delete_many()


async def test_alert_checks_are_scheduled_only_with_a_webhook(client):
    key = f"alerts:{alerts.slot()}"
    await db.job.delete_many(where={"dedupKey": key})
    await alerts.schedule()
    assert not await db.job.find_unique(where={"dedupKey": key}), "no webhook, no checks"


async def test_alert_checks_are_scheduled_once_per_slot(client, monkeypatch, webhook):
    key = f"alerts:{alerts.slot()}"
    await db.job.delete_many(where={"dedupKey": key})
    monkeypatch.setitem(jobs.HANDLERS, "alerts", lambda payload: _nothing())
    for _ in range(3):
        await alerts.schedule()
    assert await db.job.count(where={"dedupKey": key}) == 1
    await jobs.wait_idle(("alerts",))
    await db.job.delete_many(where={"dedupKey": key})


async def _nothing() -> list:
    return []
