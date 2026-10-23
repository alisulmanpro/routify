"""Empties every app table in the database from DATABASE_URL (.env). The schema and migrations stay.

Dev only: this deletes all users, routes, deliveries, plans and subscriptions and can't be undone
(except with Neon's point-in-time restore). Run from backend-py:  .venv/bin/python scripts/flush_dev_db.py
"""
import asyncio
from datetime import timedelta

from dotenv import load_dotenv

load_dotenv(".env")

from prisma import Prisma

TABLES = ["users", "deliveries", "routes", "route_stops", "reports", "plans", "subscriptions", "payments", "refresh_tokens", "store_purchases", "password_resets", "audit_logs", "settings", "geocode_cache", "rate_limits"]


async def main() -> None:
    db = Prisma()
    await db.connect(timeout=timedelta(seconds=60))
    try:
        await db.execute_raw("TRUNCATE TABLE " + ", ".join(f'"{t}"' for t in TABLES) + " RESTART IDENTITY CASCADE")
        for t in TABLES:
            rows = await db.query_raw(f'select count(*)::int as n from "{t}"')
            print(f"{t}: {rows[0]['n']}")
    finally:
        await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
