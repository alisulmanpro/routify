"""Alerts (P7.6): every 5 minutes the worker checks the last 5 minutes and posts what is wrong to ALERT_WEBHOOK_URL
(a Slack-compatible incoming webhook: {"text": ...}). Each kind of alert is sent at most once an hour (Google spend:
once a day), through a job with a unique dedupKey, so several workers never send it twice and a failed post is retried.

    errors   5xx share of API requests  > ALERT_ERROR_RATE   (at least MIN_REQUESTS requests)
    p95      API p95 latency            > ALERT_P95_MS       (at least MIN_REQUESTS requests)
    backlog  jobs due but not started  >= ALERT_QUEUE_BACKLOG, or the oldest has waited > 2 min (is the worker up?)
    google   today's estimated Google Maps spend > ALERT_GOOGLE_DAILY_USD
"""
from __future__ import annotations

import logging
from datetime import timedelta

import httpx

from ..config import env
from ..db import db
from ..http import now, today_key
from ..logger import log
from ..metrics import BUCKETS_MS, percentile_ms
from . import jobs

WINDOW = timedelta(minutes=5)
MIN_REQUESTS = 50
BACKLOG_WAIT = timedelta(minutes=2)
# USD per call (per 1,000 / 1,000), first paid tier (perf.md "Phase 5"). routes_matrix counts 25 × 25 blocks.
GOOGLE_USD_PER_CALL = {
    "geocoding": 0.005, "geocoding_reverse": 0.005, "places_autocomplete": 0.00283, "places_details": 0.005,
    "places_text_search": 0.032, "places_text_search_ids": 0.0, "routes_matrix": 625 * 0.005,
}


def slot(at=None) -> str:
    """The 5-minute slot a check belongs to, e.g. "2026-10-23T10:05"."""
    at = at or now()
    return f"{at:%Y-%m-%dT%H}:{at.minute // 5 * 5:02d}"


async def schedule() -> None:
    """Called with the maintenance schedule (about once a minute per worker); one check per slot however many workers."""
    if env.ALERT_WEBHOOK_URL:
        await jobs.schedule_once("alerts", f"alerts:{slot()}")


async def check() -> list[tuple[str, str]]:
    """[(kind, text)] for every threshold crossed now."""
    found: list[tuple[str, str]] = []
    since = now() - WINDOW
    rows = await db.requestminute.find_many(where={"minute": {"gte": since}})
    requests = sum(r.requests for r in rows)
    if requests >= MIN_REQUESTS:
        errors = sum(r.errors for r in rows)
        if errors / requests > env.ALERT_ERROR_RATE:
            found.append(("errors", f"API errors: {errors} of {requests} requests ({errors / requests:.1%}) failed with 5xx in the last 5 min"))
        buckets = [sum(b) for b in zip(*(list(r.buckets) for r in rows), strict=True)] if rows else [0] * (len(BUCKETS_MS) + 1)
        p95 = percentile_ms(buckets)
        if p95 is not None and p95 > env.ALERT_P95_MS:
            found.append(("p95", f"API slow: p95 ≤ {p95} ms over {requests} requests in the last 5 min (limit {env.ALERT_P95_MS} ms)"))

    due = {"status": "queued", "OR": [{"runAfter": None}, {"runAfter": {"lte": now()}}]}
    backlog = await db.job.count(where=due)
    oldest = await db.job.find_first(where=due, order={"createdAt": "asc"})
    waited = now() - oldest.createdAt if oldest else timedelta(0)
    if backlog >= env.ALERT_QUEUE_BACKLOG or waited > BACKLOG_WAIT:
        found.append(("backlog", f"Job queue: {backlog} job(s) waiting, the oldest for {int(waited.total_seconds() // 60)} min. Is the worker running?"))

    usage = await db.googleusage.group_by(by=["api"], where={"day": today_key()}, sum={"calls": True})
    spend = sum((row["_sum"]["calls"] or 0) * GOOGLE_USD_PER_CALL.get(row["api"], 0.032) for row in usage)
    if spend > env.ALERT_GOOGLE_DAILY_USD:
        found.append(("google", f"Google Maps: about ${spend:.2f} today (limit ${env.ALERT_GOOGLE_DAILY_USD:.2f}). See /admin/google-usage."))
    return found


@jobs.handler("alerts")
async def _alerts_job(_payload: dict) -> list[str]:
    hour, day = now().strftime("%Y-%m-%dT%H"), today_key()
    sent = []
    for kind, text in await check():
        key = f"alert:{kind}:{day if kind == 'google' else hour}"
        if await jobs.schedule_once("alert_notice", key, {"text": f"[routify {env.NODE_ENV}] {text}"}):
            sent.append(kind)
    return sent


@jobs.handler("alert_notice", retries=2)
async def _send_notice(payload: dict) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.post(env.ALERT_WEBHOOK_URL, json={"text": payload["text"]})
    if res.status_code >= 400:
        raise RuntimeError(f"Alert webhook answered {res.status_code}")
    log(logging.WARNING, "Alert sent", text=payload["text"])
