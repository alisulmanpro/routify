"""Development helper: does this password match the account? The password is typed hidden and never printed or logged.

    python -m scripts.check_password rider@example.com
"""
from __future__ import annotations

import asyncio
import getpass
import sys

from app.db import connect, db, disconnect
from app.security import verify_password


async def main(email: str) -> int:
    await connect()
    try:
        user = await db.user.find_unique(where={"email": email.strip().lower()})
        if not user:
            print(f"No account with the email {email!r}.")
            return 1
        password = getpass.getpass("Password to test (hidden): ")
        if password != password.strip():
            print("Note: what you typed starts or ends with a space.")
        matches = await verify_password(password, user.passwordHash)
        print(f"Account: {user.email} ({user.role}, {user.status})")
        print("MATCH: this is the account's current password." if matches else "NO MATCH: this is not the account's current password.")
        if not matches and password[:1].isupper() and await verify_password(password[:1].lower() + password[1:], user.passwordHash):
            print("...but it matches with a lowercase first letter: your keyboard is auto-capitalising.")
        return 0 if matches else 2
    finally:
        await disconnect()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(64)
    sys.exit(asyncio.run(main(sys.argv[1])))
