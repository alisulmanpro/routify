"""Creates a rider who can log in straight away with Routify Premium already on (dev / test databases only).

    .venv/bin/python -m scripts.create_premium_rider <email> <password> [--name "Ali Test"] [--days 30] [--trial]

The account is made through the app's own sign-up (same password rules and hashing as the app), then given the Premium
(`pro`) plan: active for --days days (default 30), or with --trial the free trial (settings.trialDays). No payment is
involved. If the email already has an account, only its plan is switched on; its password is not changed.

Uses DATABASE_URL from .env and refuses any database that is not local or listed in DEV_DATABASE_HOSTS
(scripts/db_guard.py), so it can never hand out free plans on production.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from scripts.db_guard import endpoint_of, require_safe_database


async def create(email: str, password: str, name: str, days: int, trial: bool) -> None:
    import httpx

    from app.db import connect, db, disconnect
    from app.http import now
    from app.main import create_app
    from app.services.settings_service import get_settings
    from app.services.subscription_service import ensure_default_plans

    await connect()
    try:
        await ensure_default_plans()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://script", timeout=60) as client:
            res = await client.post("/api/v1/auth/register", json={"fullName": name, "email": email, "password": password, "confirmPassword": password})
        if res.status_code == 409:
            created = False
        elif res.is_success:
            created = True
        else:
            error = res.json().get("error", {})
            details = "; ".join(f"{d.get('path')}: {d.get('message')}" for d in error.get("details", []))
            sys.exit(f"Could not create the account: {error.get('message', res.text)}{f' ({details})' if details else ''}")

        user = await db.user.find_unique(where={"email": email})
        plan = await db.plan.find_unique(where={"key": "pro"})
        length = (await get_settings())["trialDays"] if trial else days
        sub = await db.subscription.find_first(where={"userId": user.id})
        data = {"planKey": "pro", "status": "trialing" if trial else "active", "billingCycle": "monthly",
                "price": plan.monthlyPrice if plan else 0, "currency": plan.currency if plan else "EUR",
                "startedAt": now(), "currentPeriodEnd": now() + timedelta(days=length), "cancelAtPeriodEnd": False,
                "pendingPlanKey": None, "pendingBillingCycle": None, "pendingPaymentId": None}
        if sub:
            await db.subscription.update(where={"id": sub.id}, data=data)
        else:
            from app.ids import new_id
            await db.subscription.create(data={"id": new_id(), "userId": user.id, **data})

        state = "free trial" if trial else "active"
        print(f"{'Created' if created else 'Existing account'}: {email}"
              f"{f' / {password}' if created else ' (password unchanged)'}")
        print(f"Plan: {plan.name if plan else 'Premium'}, {state} for {length} day{'s' if length != 1 else ''}. Log in to the app with it.")
    finally:
        await disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("email")
    parser.add_argument("password")
    parser.add_argument("--name", default="Test Rider", help="the rider's name (default: Test Rider)")
    parser.add_argument("--days", type=int, default=30, help="how long Premium is on (default 30 days)")
    parser.add_argument("--trial", action="store_true", help="start the free trial instead (length from the admin settings)")
    args = parser.parse_args()
    if not 1 <= args.days <= 3650:
        parser.error("--days must be 1 to 3650")
    url = os.environ.get("DATABASE_URL", "")
    # Allowlisted dev databases only; it adds one account, so no typed confirmation is asked for.
    require_safe_database(url, f"create a Premium rider {args.email}", confirm=endpoint_of(urlsplit(url).hostname or ""))
    os.environ["EMAIL_PROVIDER"] = "console"  # the welcome email goes to the log, not to a real inbox
    os.environ["LOG_LEVEL"] = "error"  # only this script's own lines, not every request
    asyncio.run(create(args.email.strip().lower(), args.password, args.name, args.days, args.trial))


if __name__ == "__main__":
    main()
