from __future__ import annotations

import asyncio
import time
from datetime import timedelta

from starlette.requests import Request

from .db import db
from .errors import forbidden, unauthorized
from .http import now
from .ids import is_object_id
from .security import verify_access_token

TOUCH_INTERVAL = timedelta(minutes=5)
_background: set[asyncio.Task] = set()

# The account fields every request checks, kept per process for a short time so most requests skip the users lookup.
# Changes made through this process clear the entry at once (invalidate_user); other workers see them within USER_CACHE_SECONDS.
USER_CACHE_SECONDS = 30.0
_USER_CACHE_MAX = 10_000
_user_cache: dict[str, tuple[float, dict]] = {}  # user id -> (expires at, monotonic seconds; account snapshot)


def invalidate_user(user_id: str) -> None:
    _user_cache.pop(user_id, None)


async def _load_account(user_id: str) -> dict | None:
    at = time.monotonic()
    cached = _user_cache.get(user_id)
    if cached and cached[0] > at:
        return cached[1]
    user = await db.user.find_unique(where={"id": user_id})
    if not user:
        _user_cache.pop(user_id, None)
        return None
    account = {"id": user.id, "role": str(user.role), "email": user.email, "fullName": user.fullName,
               "tokenVersion": user.tokenVersion, "status": str(user.status), "lastActiveAt": user.lastActiveAt}
    if len(_user_cache) >= _USER_CACHE_MAX:
        for key in [k for k, (expires, _) in _user_cache.items() if expires <= at] or list(_user_cache)[: _USER_CACHE_MAX // 10]:
            del _user_cache[key]
    _user_cache[user_id] = (at + USER_CACHE_SECONDS, account)
    return account


async def _touch(user_id: str) -> None:
    try:
        await db.user.update(where={"id": user_id}, data={"lastActiveAt": now()})
    except Exception:  # noqa: BLE001 - best effort
        pass


async def authenticate(request: Request, *roles: str) -> dict:
    """Verifies the bearer token, re-checks the account on every request and (optionally) the role."""
    parts = (request.headers.get("authorization") or "").split(" ")
    if len(parts) < 2 or parts[0] != "Bearer" or not parts[1]:
        raise unauthorized()

    claims = verify_access_token(parts[1])
    user = await _load_account(claims["sub"]) if is_object_id(claims.get("sub")) else None
    if not user:
        raise unauthorized("Account no longer exists", "INVALID_TOKEN")
    # Tokens from before the last password change carry an older version ("ver" is absent on pre-versioning tokens = 0).
    if claims.get("ver", 0) != user["tokenVersion"]:
        raise unauthorized("Your password was changed. Please sign in again.", "TOKEN_REVOKED")
    if user["status"] != "active":
        raise forbidden("Your account is suspended", "ACCOUNT_SUSPENDED")

    actor = {"id": user["id"], "role": user["role"], "email": user["email"], "fullName": user["fullName"]}
    request.state.user = actor

    if not user["lastActiveAt"] or now() - user["lastActiveAt"] > TOUCH_INTERVAL:
        user["lastActiveAt"] = now()  # the cached copy too, so the next requests do not touch again
        task = asyncio.create_task(_touch(user["id"]))
        _background.add(task)
        task.add_done_callback(_background.discard)

    if roles and actor["role"] not in roles:
        raise forbidden()
    return actor


def ctx(request: Request) -> dict:
    return {"ip": request.state.ip, "userAgent": request.headers.get("user-agent")}
