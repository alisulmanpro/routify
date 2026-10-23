"""Seeds a test rider with a planned route of located stops (default 200) in the dev database (P0.10).

    .venv/bin/python -m scripts.seed_dev_route [--stops 200] [--email rider200@example.com] [--date YYYY-MM-DD] [--confirm <endpoint>]

Uses DATABASE_URL from .env and refuses any database that is not local or listed in DEV_DATABASE_HOSTS
(scripts/db_guard.py). The rider gets an active Pro plan. Running it again replaces that rider's stops and routes for
the date. Stops are a grid around Dublin city centre (about 100 m apart) with coordinates, so no Google call is made
(maps providers are switched off for the run); the route is planned by the built-in planner, in an in-process worker.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from scripts.db_guard import require_safe_database

PASSWORD = "Rider-200-pass!"


def stops(n: int, date: str) -> list[dict]:
    return [{"clientId": str(uuid.uuid4()), "trackingId": f"SEED-{i + 1:04d}", "address": {"raw": f"{i + 1} Seed Street, Dublin"},
             "location": {"latitude": 53.33 + (i // 20) * 0.001, "longitude": -6.29 + (i % 20) * 0.0015}, "serviceDate": date}
            for i in range(n)]


async def seed(email: str, n: int, date: str) -> None:
    import httpx

    from app import worker
    from app.db import connect, db, disconnect
    from app.main import create_app
    from app.services.subscription_service import ensure_default_plans

    await connect()
    await ensure_default_plans()
    stop = asyncio.Event()
    worker_task = asyncio.create_task(worker.run(stop, poll=0.05, schedule=False))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://seed", timeout=300) as client:
            res = await client.post("/api/v1/auth/register", json={"fullName": "Seed Rider 200", "email": email, "password": PASSWORD,
                                                                     "confirmPassword": PASSWORD, "currency": "EUR"})
            if res.status_code == 409:
                res = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
            res.raise_for_status()
            body = res.json()["data"]
            rider_id = body["user"]["id"]
            auth = {"Authorization": f"Bearer {body['accessToken']}"}

            await db.subscription.update_many(where={"userId": rider_id}, data={"planKey": "pro", "status": "active",
                                                                                 "currentPeriodEnd": datetime.now(UTC) + timedelta(days=30)})
            # A fresh day: this rider's earlier seed for the date goes (stop rows first, then deliveries, then routes).
            old_routes = [r.id for r in await db.route.find_many(where={"riderId": rider_id, "serviceDate": date})]
            if old_routes:
                await db.routestop.delete_many(where={"routeId": {"in": old_routes}})
            await db.delivery.delete_many(where={"riderId": rider_id, "serviceDate": date})
            await db.route.delete_many(where={"id": {"in": old_routes}})

            items = stops(n, date)
            ids: list[str] = []
            for i in range(0, len(items), 500):
                created = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": items[i:i + 500]})
                created.raise_for_status()
                ids += [s["id"] for s in created.json()["data"]["stops"]]
            built = await client.post("/api/v1/routes/build", headers=auth, json={"name": f"Seed {n} stops", "date": date, "deliveryIds": ids,
                                                                                   "origin": {"latitude": 53.3498, "longitude": -6.2603}})
            built.raise_for_status()
            route = built.json()["data"]
            print(f"Rider {email} / {PASSWORD} (id {rider_id}): route {route['id']} on {date} with {len(route['stops'])} stops, "
                  f"{route['distanceKm']} km, planned by {route['optimization']}.")
    finally:
        stop.set()
        await worker_task
        await disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stops", type=int, default=200)
    parser.add_argument("--email", default="rider200@example.com")
    parser.add_argument("--date", default=datetime.now(UTC).strftime("%Y-%m-%d"))
    parser.add_argument("--confirm", help="the database endpoint name, instead of typing it")
    args = parser.parse_args()
    if not 1 <= args.stops <= 2000:
        parser.error("--stops must be 1 to 2000")
    require_safe_database(os.environ.get("DATABASE_URL", ""), f"create or replace a {args.stops}-stop route for {args.email}", confirm=args.confirm)
    # No billed map calls and no real emails from a seed run.
    os.environ.update({"GEOCODING_PROVIDER": "none", "ROUTING_PROVIDER": "none", "EMAIL_PROVIDER": "console", "GOOGLE_MAPS_API_KEY": ""})
    asyncio.run(seed(args.email.lower(), args.stops, args.date))


if __name__ == "__main__":
    main()
