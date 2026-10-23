#!/usr/bin/env python3
"""Create the riders (and their 200-stop routes) the load test uses, and write the
rider file the k6/Locust scenarios read.

Staging only: the script refuses any host that does not look like a staging
environment. Nothing is sent to production.

    python3 infra/loadtest/scripts/seed_riders.py \
        --base-url https://routify-api-staging.onrender.com \
        --riders 100 --stops 200 \
        --out infra/loadtest/data/riders.json

Every rider gets:
  * an account (POST /api/v1/auth/register, or login if the address is taken),
  * an active plan ("pro": the trial plan allows only 100 deliveries a month, and a
    200-stop route needs more than that),
  * `--stops` stops (POST /api/v2/deliveries/batch, one call, client ids from uuid4),
  * a route over those stops (POST /api/v1/routes/build) and, with --start, the
    route is started.

Rate limits: the API counts 1,000 requests per IP per 15 minutes and registration is
limited to 40 per IP per 15 minutes. Seeding 10,000 riders is about 40,000 requests,
so run the seed from several IPs or raise the limits on the staging environment
before seeding (see infra/loadtest/README.md).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PROD_HOSTS = [
    "routify-api.onrender.com",
    "api.routify.ie",
    "www.routify.ie",
    "routify.ie",
]
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ApiError(Exception):
    def __init__(self, status: int, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


class Client:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.token: str | None = None

    def call(self, method: str, path: str, body=None, headers=None):
        url = f"{self.base}{path}"
        data = None
        hdrs = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        hdrs.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read().decode()
                return res.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {"raw": raw}
            raise ApiError(exc.code, parsed) from None

    def data(self, method: str, path: str, body=None, headers=None):
        status, payload = self.call(method, path, body, headers)
        if not isinstance(payload, dict) or not payload.get("success"):
            raise ApiError(status, payload)
        return payload.get("data")


def assert_staging(base_url: str, allow_local: bool, pattern: str) -> str:
    if not base_url:
        sys.exit(
            "No staging URL given. Load tests may only run against a staging environment.\n"
            "Pass --base-url https://<your-staging-host> (nothing was sent)."
        )
    m = re.match(r"^https?://([^/:]+)", base_url)
    if not m:
        sys.exit(f"--base-url is not a valid http(s) URL: {base_url}")
    host = m.group(1).lower()
    if host in LOCAL_HOSTS:
        if not allow_local:
            sys.exit(
                f"Refusing to seed against {host}. Use --allow-local for a local rehearsal "
                "(its numbers are not staging numbers)."
            )
        return base_url.rstrip("/")
    if any(host == p or host.endswith("." + p) for p in PROD_HOSTS):
        sys.exit(f"Refusing to seed against production host {host}. Staging only.")
    if not re.search(pattern, host, re.IGNORECASE):
        sys.exit(
            f"Refusing to seed against {host}: the hostname does not look like a staging host "
            f"(pattern {pattern!r}). Staging only."
        )
    return base_url.rstrip("/")


def register_or_login(client: Client, email: str, password: str) -> dict:
    try:
        data = client.data(
            "POST",
            "/api/v1/auth/register",
            {"fullName": "Load Test Rider", "email": email, "password": password, "confirmPassword": password},
        )
        return data
    except ApiError as exc:
        if exc.status not in (400, 409):
            raise
    data = client.data("POST", "/api/v1/auth/login", {"email": email, "password": password, "client": "mobile"})
    return data


def activate_plan(client: Client, mode: str, admin_email: str, admin_password: str, plan_key: str) -> str:
    """Give the rider an active plan. Returns a note for the log."""
    if mode == "none":
        return "no plan activated"
    if mode == "mock":
        # Needs PAYMENT_STORES=mock and ALLOW_MOCK_STORE=true on the target.
        # The mock store's product ids look like "pro.monthly" / "starter.annual".
        try:
            client.data(
                "POST",
                "/api/v1/subscriptions/purchases",
                {"store": "mock", "productId": f"{plan_key}.monthly", "trial": True, "receipt": None},
            )
            return "plan activated with the mock store"
        except ApiError as exc:
            return f"mock store refused ({exc.status}); the rider may not be able to add stops"
    if mode == "admin":
        sub = client.data("GET", "/api/v1/subscriptions/me")
        sub_id = sub.get("subscription", {}).get("id")
        if not sub_id:
            return "no subscription id found"
        admin = Client(client.base)
        admin.data("POST", "/api/v1/auth/login", {"email": admin_email, "password": admin_password, "client": "web"})
        admin.data(
            "PATCH",
            f"/api/v1/admin/subscriptions/{sub_id}",
            {"status": "trialing", "planKey": plan_key, "billingCycle": "monthly"},
        )
        return "plan activated by the admin"
    raise SystemExit(f"unknown --activate mode: {mode}")


def make_stop(i: int, prefix: str):
    lat = 53.30 + ((i * 37) % 1000) / 10000
    lng = -6.30 + ((i * 53) % 1000) / 10000
    return {
        "clientId": str(uuid.uuid4()),
        "trackingId": f"{prefix}-{i}",
        "customer": {"name": f"Load Test {i}"},
        "address": {"raw": f"{i} Load Test Street, Dublin 1, D01 AB{i % 100:02d}"},
        "location": {"latitude": lat, "longitude": lng},
    }


def seed_rider(base_url: str, index: int, stops: int, domain: str, password: str, activate: str,
               admin_email: str, admin_password: str, plan_key: str, start: bool) -> dict:
    client = Client(base_url)
    email = f"loadtest+{index:06d}@{domain}"
    auth = register_or_login(client, email, password)
    client.token = auth["accessToken"]
    rider = {
        "email": email,
        "password": password,
        "accessToken": auth["accessToken"],
        "refreshToken": auth.get("refreshToken"),
        "routeId": None,
        "stopIds": [],
    }
    if stops <= 0:
        return rider

    note = activate_plan(client, activate, admin_email, admin_password, plan_key)
    rider["plan"] = note

    items = [make_stop(i, f"LT{index}") for i in range(stops)]
    batch = client.data("POST", "/api/v2/deliveries/batch", {"items": items})
    rider["stopIds"] = [s["id"] for s in batch.get("stops", [])]

    route = client.data("POST", "/api/v1/routes/build", {"preference": "smart"})
    rider["routeId"] = route["id"]
    if start:
        try:
            client.data("POST", f"/api/v1/routes/{route['id']}/start", {})
        except ApiError as exc:
            rider["startError"] = str(exc)
    return rider


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.environ.get("LOADTEST_BASE_URL", ""), help="staging API base URL")
    ap.add_argument("--riders", type=int, default=10, help="how many riders to create")
    ap.add_argument("--stops", type=int, default=200, help="stops per rider (0 = no stops, no route)")
    ap.add_argument("--out", default="infra/loadtest/data/riders.json", help="rider file to write")
    ap.add_argument("--domain", default=os.environ.get("LOADTEST_EMAIL_DOMAIN", "example.test"))
    ap.add_argument("--password", default=os.environ.get("LOADTEST_PASSWORD", "LoadTest!2026"))
    ap.add_argument("--activate", choices=["mock", "admin", "none"], default=os.environ.get("LOADTEST_ACTIVATE", "mock"))
    ap.add_argument("--plan", default="pro", help="plan key to activate")
    ap.add_argument("--admin-email", default=os.environ.get("LOADTEST_ADMIN_EMAIL", ""))
    ap.add_argument("--admin-password", default=os.environ.get("LOADTEST_ADMIN_PASSWORD", ""))
    ap.add_argument("--start", action="store_true", help="start the route after building it")
    ap.add_argument("--pause", type=float, default=0.0, help="seconds to wait between riders (rate limits)")
    ap.add_argument("--allow-local", action="store_true", help="allow a local rehearsal (not a staging result)")
    ap.add_argument("--staging-pattern", default=os.environ.get("STAGING_HOST_PATTERN", "staging"))
    ap.add_argument("--continue-on-error", action="store_true", help="keep going when a rider fails")
    args = ap.parse_args()

    base = assert_staging(args.base_url, args.allow_local, args.staging_pattern)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    riders = []
    failures = 0
    for i in range(args.riders):
        try:
            riders.append(seed_rider(
                base, i, args.stops, args.domain, args.password, args.activate,
                args.admin_email, args.admin_password, args.plan, args.start,
            ))
        except ApiError as exc:
            failures += 1
            print(f"rider {i}: FAILED {exc}", file=sys.stderr)
            if not args.continue_on_error:
                break
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"rider {i}: FAILED {exc}", file=sys.stderr)
            if not args.continue_on_error:
                break
        if (i + 1) % 25 == 0:
            print(f"{i + 1}/{args.riders} riders ready", flush=True)
        if args.pause:
            time.sleep(args.pause)

    out.write_text(json.dumps(riders, indent=1))
    print(f"wrote {len(riders)} riders to {out} ({failures} failures)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
