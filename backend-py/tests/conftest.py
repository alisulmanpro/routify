from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Configure before the app is imported: a separate database and upload folder for tests.
from urllib.parse import urlsplit, urlunsplit

from dotenv import dotenv_values

_dotenv = dotenv_values(ROOT / ".env")


def _setting(name: str) -> str:
    return os.environ.get(name) or _dotenv.get(name) or ""


def _with_test_suffix(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=parts.path.rstrip("/") + "_test"))


def _test_database_urls() -> tuple[str, str]:
    """(TEST_DATABASE_URL, TEST_DIRECT_URL), else the dev URLs with "_test" appended to the database name.

    The suite force-resets this database (through the direct URL), so neither may be a dev one."""
    dev_urls = {_setting("DATABASE_URL"), _setting("DIRECT_URL")} - {""}
    url = _setting("TEST_DATABASE_URL")
    direct = _setting("TEST_DIRECT_URL")
    if not url:
        url = _with_test_suffix(_setting("DATABASE_URL"))
        direct = direct or (_with_test_suffix(_setting("DIRECT_URL")) if _setting("DIRECT_URL") else "")
    direct = direct or url
    for candidate in (url, direct):
        if not urlsplit(candidate).path.strip("/") or candidate in dev_urls:
            raise RuntimeError("TEST_DATABASE_URL / TEST_DIRECT_URL must point at a separate database; the tests wipe it.")
    return url, direct


os.environ["NODE_ENV"] = "test"
os.environ["DATABASE_URL"], os.environ["DIRECT_URL"] = _test_database_urls()
os.environ.setdefault("JWT_ACCESS_SECRET", "a" * 32)
os.environ.setdefault("JWT_REFRESH_SECRET", "b" * 32)
os.environ.setdefault("FILE_SIGNING_SECRET", "c" * 32)
os.environ["STORAGE_DIR"] = "./tests/tmp-uploads"
# Billing tests enable the stores they need themselves; never inherit the dev stores or call RevenueCat with a real key.
os.environ["PAYMENT_STORES"] = "mock"
# Same for maps: never make billed Google calls from tests.
os.environ["GEOCODING_PROVIDER"] = "none"  # tests stub the geocoder they need; never call live OSM/Google
os.environ["ROUTING_PROVIDER"] = "none"
os.environ["OSRM_URL"] = ""
os.environ["VROOM_URL"] = ""
os.environ["EMAIL_PROVIDER"] = "console"  # and never send real email
for _name in ("REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTH", "GOOGLE_MAPS_API_KEY"):
    os.environ[_name] = ""


def _reset_database() -> None:
    scripts = Path(sys.executable).parent
    env = {**os.environ, "PATH": f"{scripts}{os.pathsep}{os.environ.get('PATH', '')}"}
    # The real migrations, not `db push`: they also hold what schema.prisma cannot (the one-active-route partial index).
    subprocess.run([str(scripts / "prisma"), "migrate", "reset", "--force", "--skip-generate", "--skip-seed"],
                   cwd=ROOT, env=env, check=True, capture_output=True)


@pytest.fixture(scope="session")
async def client():
    import httpx

    _reset_database()
    shutil.rmtree(ROOT / "tests" / "tmp-uploads", ignore_errors=True)

    from app.db import connect, disconnect
    from app.main import create_app
    from app.services.settings_service import reset_settings_cache
    from app.services.subscription_service import ensure_default_plans

    await connect()
    reset_settings_cache()
    await ensure_default_plans()
    application = create_app(run_jobs=False)
    # The worker process (python -m app.worker), here as a task with a short poll: route planning jobs run in it.
    from app import worker

    stop = asyncio.Event()
    worker_task = asyncio.create_task(worker.run(stop, poll=0.02))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as c:
        yield c
    stop.set()
    await worker_task
    await disconnect()
    shutil.rmtree(ROOT / "tests" / "tmp-uploads", ignore_errors=True)
