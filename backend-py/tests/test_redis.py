"""P7.2: with Redis, rate limits and caches are shared by every API process. Needs TEST_REDIS_URL (skipped without)."""
from __future__ import annotations

import asyncio
import dataclasses
import os
import sys
import textwrap
import uuid

import pytest

from app import redis_client
from app.config import env

from .test_api import make_admin, rider

REDIS_URL = os.environ.get("TEST_REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="set TEST_REDIS_URL to a throwaway Redis to run these")


@pytest.fixture
async def redis_on(monkeypatch):
    prefix = f"test-{uuid.uuid4().hex[:8]}:"
    monkeypatch.setattr(redis_client, "env", dataclasses.replace(env, REDIS_URL=REDIS_URL, REDIS_KEY_PREFIX=prefix))
    monkeypatch.setattr(redis_client, "_client", None)
    monkeypatch.setattr(redis_client, "_down_until", 0.0)
    yield prefix
    client = redis_client.client()
    if client is not None:
        keys = [k async for k in client.scan_iter(f"{prefix}*")]
        if keys:
            await client.delete(*keys)
    await redis_client.close()


# A separate Python process using the app's RateLimiter: 8 hits on a shared 10-per-minute limit.
WORKER = textwrap.dedent("""
    import asyncio, os
    from app.middleware import RateLimiter
    async def main():
        limiter = RateLimiter("two-processes", 60, 10, enforce=True, store="memory")
        allowed = 0
        for _ in range(8):
            try:
                await limiter.check("203.0.113.50"); allowed += 1
            except Exception as error:
                assert getattr(error, "code", None) == "RATE_LIMITED", error
        print(allowed)
    asyncio.run(main())
""")


async def test_rate_limits_are_shared_by_two_processes(redis_on):
    environment = {**os.environ, "REDIS_URL": REDIS_URL, "REDIS_KEY_PREFIX": redis_on, "NODE_ENV": "development"}
    procs = [await asyncio.create_subprocess_exec(sys.executable, "-c", WORKER, env=environment, cwd=os.getcwd(),
                                                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE) for _ in range(2)]
    outputs = [await p.communicate() for p in procs]
    for proc, (out, err) in zip(procs, outputs):
        assert proc.returncode == 0, err.decode()[-500:]
    allowed = [int(out.decode().strip()) for out, _ in outputs]
    # 16 hits from two processes against one limit of 10: exactly 10 get through, wherever they came from.
    assert sum(allowed) == 10, allowed


async def test_account_cache_is_shared_and_invalidated_everywhere(client, redis_on):
    from app import auth as auth_module

    body, auth = await rider(client, "p7-redis-account@example.com")
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 200
    assert await redis_client.client().exists(redis_client.key("user", body["user"]["id"]))
    # Another process: nothing in its own memory, the account comes from Redis.
    auth_module._user_cache.clear()
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 200
    # A suspension drops the shared copy, so every process refuses the next request.
    admin_auth, _ = await make_admin(client, "p7-redis-admin@example.com")
    client.cookies.clear()
    await client.patch(f"/api/v1/admin/riders/{body['user']['id']}", headers=admin_auth, json={"status": "suspended"})
    assert not await redis_client.client().exists(redis_client.key("user", body["user"]["id"]))
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 403


async def test_a_settings_change_reaches_every_instance(client, redis_on):
    from app.services import settings_service as settings

    before = await settings.get_settings()
    # Another instance changes the settings: this one notices at once through the shared version, not after 15 s.
    await redis_client.client().incr(redis_client.key("settings-version"))
    await settings.db.setting.upsert(where={"key": "platform"}, data={
        "create": {"id": uuid.uuid4().hex[:24], "key": "platform", "value": settings.as_json({"trialDays": 21})},
        "update": {"value": settings.as_json(settings.merge(before, {"trialDays": 21}))}})
    assert (await settings.get_settings())["trialDays"] == 21
    await settings.update_settings({"trialDays": before["trialDays"]})


async def test_without_a_reachable_redis_everything_falls_back(client, monkeypatch):
    monkeypatch.setattr(redis_client, "env", dataclasses.replace(env, REDIS_URL="redis://127.0.0.1:9/0"))
    monkeypatch.setattr(redis_client, "_client", None)
    monkeypatch.setattr(redis_client, "_down_until", 0.0)
    from app.middleware import RateLimiter

    limiter = RateLimiter("fallback-test", 60, 1, enforce=True, store="memory")
    await limiter.check("203.0.113.60")
    with pytest.raises(Exception) as blocked:
        await limiter.check("203.0.113.60")
    assert getattr(blocked.value, "code", None) == "RATE_LIMITED"
    assert redis_client.client() is None, "after a failure Redis is skipped for a while"
    _, auth = await rider(client, "p7-redis-down@example.com")
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 200
    monkeypatch.setattr(redis_client, "_client", None)
