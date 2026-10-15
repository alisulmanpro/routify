from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Configure before the app is imported: a separate database and upload folder for tests.
from urllib.parse import urlsplit, urlunsplit  # noqa: E402

from dotenv import dotenv_values  # noqa: E402

_dotenv = dotenv_values(ROOT / ".env")


def _test_database_url() -> str:
    """TEST_DATABASE_URL, else the dev URL with "_test" appended to the database name.

    The suite force-resets this database, so it must never be the dev one."""
    dev_url = os.environ.get("DATABASE_URL") or _dotenv.get("DATABASE_URL") or ""
    url = os.environ.get("TEST_DATABASE_URL") or _dotenv.get("TEST_DATABASE_URL")
    if not url:
        parts = urlsplit(dev_url)
        url = urlunsplit(parts._replace(path=parts.path.rstrip("/") + "_test"))
    if not urlsplit(url).path.strip("/") or url == dev_url:
        raise RuntimeError("TEST_DATABASE_URL must point at a separate database; the tests wipe it.")
    return url


os.environ["NODE_ENV"] = "test"
os.environ["DATABASE_URL"] = _test_database_url()
os.environ.setdefault("JWT_ACCESS_SECRET", "a" * 32)
os.environ.setdefault("JWT_REFRESH_SECRET", "b" * 32)
os.environ.setdefault("FILE_SIGNING_SECRET", "c" * 32)
os.environ["STORAGE_DIR"] = "./tests/tmp-uploads"
# Billing tests enable the stores they need themselves; never inherit the dev stores or call RevenueCat with a real key.
os.environ["PAYMENT_STORES"] = "mock"
# Same for maps: never make billed Google calls from tests.
os.environ["GEOCODING_PROVIDER"] = "nominatim"
os.environ["ROUTING_PROVIDER"] = "osrm"
os.environ["EMAIL_PROVIDER"] = "console"  # and never send real email
for _name in ("REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTH", "GOOGLE_MAPS_API_KEY"):
    os.environ[_name] = ""


def _reset_database() -> None:
    scripts = Path(sys.executable).parent
    env = {**os.environ, "PATH": f"{scripts}{os.pathsep}{os.environ.get('PATH', '')}"}
    subprocess.run([str(scripts / "prisma"), "db", "push", "--force-reset", "--skip-generate", "--accept-data-loss"],
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
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as c:
        yield c
    await disconnect()
    shutil.rmtree(ROOT / "tests" / "tmp-uploads", ignore_errors=True)
