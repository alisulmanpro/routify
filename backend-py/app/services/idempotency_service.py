"""Idempotency-Key handling for /v2 writes.

The first request with a key claims it, runs, and stores its answer. A retry with the same key and the same request
gets that stored answer back (no second side effect); the same key with a different request is refused with 409.
Answers below 500 are stored (a 409 "already delivered" stays a 409 on retry); a 5xx or a crash frees the key so the
retry runs for real. A claim left by a crashed worker can be taken over after CLAIM_TIMEOUT.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any

import orjson
from prisma.errors import UniqueViolationError
from starlette.requests import Request
from starlette.responses import Response

from ..db import db
from ..errors import AppError, error_body
from ..http import dumps, now

KEY_HEADER = "idempotency-key"
_KEY_RE = re.compile(r"^[\w.:-]{8,128}$")
KEY_TTL = timedelta(hours=24)
CLAIM_TIMEOUT = timedelta(seconds=60)


def request_hash(*parts: Any) -> str:
    """A stable fingerprint of the request's meaningful content (not of headers or multipart boundaries)."""
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part if isinstance(part, bytes) else orjson.dumps(part, option=orjson.OPT_SORT_KEYS))
        digest.update(b"\x00")
    return digest.hexdigest()


def key_from(request: Request) -> str:
    key = (request.headers.get(KEY_HEADER) or "").strip()
    if not key:
        raise AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (a new random id per action) with this request")
    if not _KEY_RE.match(key):
        raise AppError(400, "INVALID_IDEMPOTENCY_KEY", "The Idempotency-Key must be 8-128 letters, digits, '-', '_', '.' or ':'")
    return key


def _replay(row: Any) -> Response:
    return Response(content=(row.responseBody or "").encode(), status_code=row.responseStatus or 200,
                    media_type="application/json", headers={"Idempotent-Replayed": "true"})


async def _claim(rider_id: str, key: str, scope: str, fingerprint: str) -> Any | None:
    """Claims the key (None), or returns the existing row when it was already claimed."""
    try:
        await db.idempotencykey.create(data={"riderId": rider_id, "key": key, "scope": scope, "requestHash": fingerprint,
                                             "expiresAt": now() + KEY_TTL})
        return None
    except UniqueViolationError:
        return await db.idempotencykey.find_unique(where={"riderId_key": {"riderId": rider_id, "key": key}})


async def run(request: Request, actor: dict, scope: str, fingerprint: str, action: Callable[[], Awaitable[tuple[int, Any]]]) -> Response:
    """Runs `action` (returning (status, body)) at most once per Idempotency-Key and replays its answer afterwards."""
    key = key_from(request)
    existing = await _claim(actor["id"], key, scope, fingerprint)
    if existing is not None:
        if existing.scope != scope or existing.requestHash != fingerprint:
            raise AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request")
        if existing.state == "done":
            return _replay(existing)
        # Still running elsewhere, unless that worker died: then take the claim over (only one retry can win it).
        stale = existing.lockedAt < now() - CLAIM_TIMEOUT
        if not stale or not await db.idempotencykey.update_many(
                where={"riderId": actor["id"], "key": key, "state": "in_progress", "lockedAt": existing.lockedAt}, data={"lockedAt": now()}):
            raise AppError(409, "IDEMPOTENCY_IN_PROGRESS", "This request is still being processed. Try again in a moment.")

    try:
        status, body = await action()
    except AppError as error:
        if error.status >= 500:
            await _release(actor["id"], key)
            raise
        status, body = error.status, error_body(error.code, error.message, error.details)
    except BaseException:
        await _release(actor["id"], key)
        raise

    payload = dumps(body)
    await db.idempotencykey.update_many(where={"riderId": actor["id"], "key": key},
                                        data={"state": "done", "responseStatus": status, "responseBody": payload.decode()})
    return Response(content=payload, status_code=status, media_type="application/json")


async def _release(rider_id: str, key: str) -> None:
    try:
        await db.idempotencykey.delete_many(where={"riderId": rider_id, "key": key, "state": "in_progress"})
    except Exception:  # noqa: BLE001, S110 - the claim then simply times out
        pass
