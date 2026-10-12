from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Configure before the app is imported: a separate database and upload folder for tests.
from dotenv import dotenv_values  # noqa: E402

_dev_url = os.environ.get("DATABASE_URL") or dotenv_values(ROOT / ".env").get("DATABASE_URL") or ""
os.environ["NODE_ENV"] = "test"
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or _dev_url.replace("/routify?", "/routify_test?")
os.environ.setdefault("JWT_ACCESS_SECRET", "a" * 32)
os.environ.setdefault("JWT_REFRESH_SECRET", "b" * 32)
os.environ.setdefault("FILE_SIGNING_SECRET", "c" * 32)
os.environ["STORAGE_DIR"] = "./tests/tmp-uploads"


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
