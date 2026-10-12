from __future__ import annotations

from typing import Any

from prisma import Json, Prisma

db = Prisma()


async def connect() -> None:
    if not db.is_connected():
        await db.connect()


async def disconnect() -> None:
    if db.is_connected():
        await db.disconnect()


async def is_ready() -> bool:
    if not db.is_connected():
        return False
    try:
        await db.query_raw("SELECT 1")
        return True
    except Exception:  # noqa: BLE001 - readiness probe
        return False


def as_json(value: Any) -> Json:
    """Prisma needs JSON column values wrapped explicitly."""
    return Json(value)
