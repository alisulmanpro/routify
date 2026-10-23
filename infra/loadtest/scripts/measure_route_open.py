#!/usr/bin/env python3
"""Measure what opening a route costs on the wire (task.md P8.5: < 150 KB gzipped).

Fetches `GET /api/v2/routes/{id}` with `Accept-Encoding: gzip` and reports the size
of the body, compressed and uncompressed. It also times the request.

Staging only, like every other script in this folder.

    python3 infra/loadtest/scripts/measure_route_open.py \
        --base-url https://routify-api-staging.onrender.com \
        --email loadtest+000001@example.test --password 'LoadTest!2026' \
        --route-id 0123456789abcdef01234567
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

PROD_HOSTS = [
    "routify-api.onrender.com",
    "api.routify.ie",
    "www.routify.ie",
    "routify.ie",
]


def assert_staging(base_url: str, allow_local: bool, pattern: str) -> str:
    if not base_url:
        sys.exit("No staging URL given. Load tests may only run against a staging environment.")
    m = re.match(r"^https?://([^/:]+)", base_url)
    if not m:
        sys.exit(f"--base-url is not a valid http(s) URL: {base_url}")
    host = m.group(1).lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        if not allow_local:
            sys.exit(f"Refusing to measure against {host}. Use --allow-local for a local rehearsal.")
        return base_url.rstrip("/")
    if any(host == p or host.endswith("." + p) for p in PROD_HOSTS):
        sys.exit(f"Refusing to measure against production host {host}. Staging only.")
    if not re.search(pattern, host, re.IGNORECASE):
        sys.exit(f"Refusing to measure against {host}: it does not look like a staging host (pattern {pattern!r}).")
    return base_url.rstrip("/")


def call(url: str, method: str = "GET", body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"Accept": "application/json"}
    if data:
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return res.status, dict(res.headers), raw, (time.perf_counter() - started) * 1000
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, dict(exc.headers), raw, (time.perf_counter() - started) * 1000


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.environ.get("LOADTEST_BASE_URL", ""))
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--route-id", required=True)
    ap.add_argument("--allow-local", action="store_true")
    ap.add_argument("--staging-pattern", default=os.environ.get("STAGING_HOST_PATTERN", "staging"))
    ap.add_argument("--json", help="write the result to this file")
    args = ap.parse_args()

    base = assert_staging(args.base_url, args.allow_local, args.staging_pattern)

    status, _, raw, _ = call(
        f"{base}/api/v1/auth/login",
        "POST",
        {"email": args.email, "password": args.password, "client": "mobile"},
    )
    if status != 200:
        print(f"login failed: {status} {raw[:200]!r}", file=sys.stderr)
        return 1
    token = json.loads(raw)["data"]["accessToken"]

    status, headers, raw, ms = call(
        f"{base}/api/v2/routes/{args.route_id}",
        headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "gzip"},
    )
    if status != 200:
        print(f"route open failed: {status} {raw[:200]!r}", file=sys.stderr)
        return 1

    encoding = (headers.get("Content-Encoding") or "").lower()
    wire_bytes = len(raw)
    plain_bytes = len(gzip.decompress(raw)) if encoding == "gzip" else wire_bytes
    if encoding != "gzip":
        plain_bytes = wire_bytes
        wire_bytes = len(gzip.compress(raw, 6))

    result = {
        "routeId": args.route_id,
        "status": status,
        "ms": round(ms, 1),
        "bytesUncompressed": plain_bytes,
        "bytesGzipped": wire_bytes,
        "kbUncompressed": round(plain_bytes / 1024, 1),
        "kbGzipped": round(wire_bytes / 1024, 1),
        "serverSentGzip": encoding == "gzip",
    }
    print(json.dumps(result, indent=2))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
