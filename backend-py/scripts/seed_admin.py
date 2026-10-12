"""Creates (or resets the password of) the first platform admin.

Usage: set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) in .env, then run:  python -m scripts.seed_admin
"""
from __future__ import annotations

import asyncio
import sys

from app.config import env
from app.db import connect, db, disconnect
from app.ids import new_id
from app.security import hash_password
from app.services.subscription_service import ensure_default_plans


async def main() -> int:
    if not env.ADMIN_EMAIL or not env.ADMIN_PASSWORD:
        print("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 characters) in the environment.", file=sys.stderr)
        return 1
    await connect()
    try:
        await ensure_default_plans()
        email = env.ADMIN_EMAIL.lower()
        password_hash = await hash_password(env.ADMIN_PASSWORD)
        existing = await db.user.find_unique(where={"email": email})
        if existing:
            if existing.role != "owner_admin":
                print(f"{email} exists as a {existing.role}. Pick another email.", file=sys.stderr)
                return 1
            await db.user.update(where={"id": existing.id}, data={"passwordHash": password_hash, "status": "active"})
            print(f"Updated password for admin {email}")
        else:
            await db.user.create(data={"id": new_id(), "fullName": env.ADMIN_NAME, "phone": "-", "email": email,
                                       "passwordHash": password_hash, "role": "owner_admin"})
            print(f"Created admin {email}")
        return 0
    finally:
        await disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
