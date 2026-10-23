"""Empties every app table in the database from DATABASE_URL (.env). The schema and migrations stay.

Dev only: this deletes all users, routes, deliveries, plans and subscriptions and can't be undone
(except with Neon's point-in-time restore). Run from backend-py:  .venv/bin/python -m scripts.flush_dev_db [--confirm <endpoint>]
Refuses any database that is not local or listed in DEV_DATABASE_HOSTS, and asks for the endpoint name (scripts/db_guard.py).
"""
import argparse
import asyncio
import os
from datetime import timedelta

from dotenv import load_dotenv

load_dotenv(".env")

from prisma import Prisma
from scripts.db_guard import require_safe_database

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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--confirm", help="the database endpoint name, instead of typing it")
    require_safe_database(os.environ.get("DATABASE_URL", ""), "empty every table", confirm=parser.parse_args().confirm)
    asyncio.run(main())
