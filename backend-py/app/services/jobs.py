"""Background jobs (P6b.2): stored in `jobs`, run by the worker process (python -m app.worker), never by the API.

The API enqueues. v2 answers with the job at once (the app polls GET /v2/jobs/{id}); v1 build/optimise wait for the
result (run_and_wait) so older apps keep their synchronous answer. Several workers can run: each job is claimed with
FOR UPDATE SKIP LOCKED, and a job whose worker died is queued again after STALE_AFTER.

P7.3: emails, report PDFs and the hourly maintenance run here too. A handler registered with `retries` is tried again
later (runAfter) when it fails; scheduled jobs use a unique dedupKey so that, with several workers, each runs once.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import timedelta
from typing import Any

from prisma.errors import UniqueViolationError

from ..db import as_json, db
from ..errors import AppError, not_found
from ..http import now
from ..ids import new_id
from ..logger import log
from .google_usage import current_rider

# True while a job runs: planning then happens right here (this is the worker process), not in another job.
in_worker: ContextVar[bool] = ContextVar("in_worker", default=False)

STALE_AFTER = timedelta(minutes=10)
MAX_ATTEMPTS = 3
WAIT_POLL_SECONDS = 0.25
RETRY_AFTER = timedelta(minutes=1)  # times the attempt number

Handler = Callable[[dict], Awaitable[Any]]
HANDLERS: dict[str, Handler] = {}
RETRIES: dict[str, int] = {}


def handler(job_type: str, *, retries: int = 0):
    def register(fn: Handler) -> Handler:
        HANDLERS[job_type] = fn
        RETRIES[job_type] = retries
        return fn
    return register


def serialize(job: Any) -> dict:
    return {"id": job.id, "type": job.type, "status": job.status, "result": job.result, "error": job.error,
            "createdAt": job.createdAt, "startedAt": job.startedAt, "finishedAt": job.finishedAt}


async def enqueue(job_type: str, payload: dict, *, rider_id: str | None = None, route_id: str | None = None, dedup_key: str | None = None) -> Any:
    return await db.job.create(data={"id": new_id(), "type": job_type, "input": as_json(payload), "riderId": rider_id, "routeId": route_id,
                                     "dedupKey": dedup_key})


async def schedule_once(job_type: str, dedup_key: str, payload: dict | None = None) -> bool:
    """Queues a scheduled job unless one with this key already exists (another worker queued it first)."""
    try:
        await enqueue(job_type, payload or {}, dedup_key=dedup_key)
        return True
    except UniqueViolationError:
        return False


async def get_for(actor: dict, job_id: str) -> dict:
    job = await db.job.find_first(where={"id": job_id, "riderId": actor["id"]})
    if not job:
        raise not_found("Job")
    return serialize(job)


def _planning_failed() -> AppError:
    return AppError(503, "PLANNING_FAILED", "The route could not be planned right now. Please try again.")


def _planning_busy() -> AppError:
    return AppError(503, "PLANNING_BUSY", "Route planning is taking longer than usual. Please try again in a minute.")


async def run_and_wait(job_type: str, payload: dict, *, rider_id: str | None, timeout_s: float,
                       failed: Callable[[], AppError] = _planning_failed, busy: Callable[[], AppError] = _planning_busy) -> Any:
    """Enqueues and waits for the worker's answer (v1 build/optimise, report PDFs). 503 when no worker answered in time.

    An AppError raised by the job (e.g. a plan limit) reaches the caller as it was raised."""
    job = await enqueue(job_type, payload, rider_id=rider_id)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        await asyncio.sleep(WAIT_POLL_SECONDS)
        row = await db.job.find_unique(where={"id": job.id})
        if row and row.status == "done":
            return row.result
        if row and row.status == "failed":
            raised = (row.result or {}).get("appError") if isinstance(row.result, dict) else None
            if raised:
                raise AppError(raised["status"], raised["code"], raised["message"], raised.get("details"))
            raise failed()
    log(logging.ERROR, "Job not finished in time (is the worker running?)", jobId=job.id, type=job_type)
    raise busy()


_CLAIM = """
UPDATE "jobs" SET "status" = 'running', "startedAt" = timezone('utc', now()), "attempts" = "attempts" + 1
WHERE "id" = (SELECT "id" FROM "jobs" WHERE "status" = 'queued' AND ("runAfter" IS NULL OR "runAfter" <= timezone('utc', now()))
              ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING "id"
"""


async def run_one() -> bool:
    """Claims and runs the oldest queued job. False when there was none."""
    rows = await db.query_raw(_CLAIM)
    if not rows:
        return False
    job = await db.job.find_unique(where={"id": rows[0]["id"]})
    token = in_worker.set(True)
    rider_token = current_rider.set(job.riderId)  # Google calls made for this job count for its rider
    try:
        fn = HANDLERS.get(job.type)
        if not fn:
            raise RuntimeError(f"No handler for job type {job.type}")
        result = await fn(job.input)
        await db.job.update(where={"id": job.id}, data={"status": "done", "result": as_json(result), "finishedAt": now()})
    except Exception as error:  # noqa: BLE001 - a failed job is recorded, never lost
        if isinstance(error, AppError):
            # The caller's answer (run_and_wait), e.g. 403 PLAN_LIMIT_REACHED: not a fault, never retried.
            raised = {"status": error.status, "code": error.code, "message": error.message, "details": error.details}
            log(logging.WARNING, "Job refused", jobId=job.id, type=job.type, code=error.code)
            await db.job.update(where={"id": job.id}, data={"status": "failed", "error": error.message, "result": as_json({"appError": raised}),
                                                            "finishedAt": now()})
        elif job.attempts <= RETRIES.get(job.type, 0):
            log(logging.WARNING, "Job failed; it will be tried again", jobId=job.id, type=job.type, attempt=job.attempts, exc_info=True)
            await db.job.update(where={"id": job.id}, data={"status": "queued", "startedAt": None, "runAfter": now() + RETRY_AFTER * job.attempts})
        else:
            log(logging.ERROR, "Job failed", jobId=job.id, type=job.type, exc_info=True)
            await db.job.update(where={"id": job.id}, data={"status": "failed", "error": "The job failed", "finishedAt": now()})
    finally:
        in_worker.reset(token)
        current_rider.reset(rider_token)
    return True


async def requeue_stale() -> None:
    """Jobs left running by a worker that stopped: queued again (or failed after MAX_ATTEMPTS)."""
    cutoff = now() - STALE_AFTER
    await db.job.update_many(where={"status": "running", "startedAt": {"lt": cutoff}, "attempts": {"lt": MAX_ATTEMPTS}}, data={"status": "queued"})
    await db.job.update_many(where={"status": "running", "startedAt": {"lt": cutoff}, "attempts": {"gte": MAX_ATTEMPTS}},
                             data={"status": "failed", "error": "The job did not finish", "finishedAt": now()})


async def wait_idle(job_types: tuple[str, ...], timeout_s: float = 10.0) -> None:
    """Tests: waits until no job of these types is queued (and due) or running."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        pending = await db.job.count(where={"type": {"in": list(job_types)}, "OR": [
            {"status": "running"}, {"status": "queued", "OR": [{"runAfter": None}, {"runAfter": {"lte": now()}}]}]})
        if not pending:
            return
        await asyncio.sleep(0.02)


async def delete_old() -> None:
    await db.job.delete_many(where={"finishedAt": {"lt": now() - timedelta(days=7)}})
