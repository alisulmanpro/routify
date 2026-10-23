"""Guard for scripts that wipe or bulk-write a database (P0.6): a host allowlist plus a typed confirmation.

Allowed without asking for more: local databases and the hosts (or Neon endpoint ids, e.g. ep-sweet-cloud-b57c66he)
listed in DEV_DATABASE_HOSTS (comma-separated, in .env). Anything else is refused unless the command names it with
--allow-host (only scripts that may legitimately target production offer that, e.g. the one-time MongoDB copy).
Then the operator must type the endpoint name (or pass it with --confirm) before anything is changed.
"""
from __future__ import annotations

import os
import sys
from urllib.parse import urlsplit

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def endpoint_of(host: str) -> str:
    """"ep-x-pooler.c-7.us-east-2.aws.neon.tech" → "ep-x" (the pooled and the direct host are one database)."""
    return host.split(".")[0].removesuffix("-pooler") if host not in LOCAL_HOSTS else host


def allowed_hosts(extra: list[str] | None = None) -> set[str]:
    listed = {h.strip() for h in os.environ.get("DEV_DATABASE_HOSTS", "").split(",") if h.strip()}
    return LOCAL_HOSTS | listed | {h.strip() for h in extra or [] if h.strip()}


def require_safe_database(url: str, action: str, *, confirm: str | None = None, allow_hosts: list[str] | None = None) -> str:
    """Exits (nothing changed) unless `url` is an allowed database and the operator confirmed. Returns the host."""
    host = urlsplit(url or "").hostname or ""
    if not host:
        sys.exit("DATABASE_URL is not set; nothing was changed.")
    allowed = allowed_hosts(allow_hosts)
    if host not in allowed and endpoint_of(host) not in allowed:
        sys.exit(f"Refusing to {action} on {host}: it is not on the dev allowlist. If it is a dev database, add "
                 f"{endpoint_of(host)} to DEV_DATABASE_HOSTS in .env. Nothing was changed.")
    expected = endpoint_of(host)
    if confirm is None:
        if not sys.stdin.isatty():
            sys.exit(f"Not confirmed: pass --confirm {expected} when running without a terminal. Nothing was changed.")
        confirm = input(f"This will {action} on {host}.\nType {expected} to continue: ")
    if confirm.strip() != expected:
        sys.exit("Not confirmed; nothing was changed.")
    return host
