"""Measures the rider flows from perf.md in-process: requests, database round trips and time per flow.

Drives the real ASGI app (all middleware included) against a throwaway database. Counts every round trip to the Prisma
query engine (queries, batches, transaction start/commit), the number that matters on a hosted database where each one
crosses the network. Nothing is mocked except the map providers (set to "none": no Google/OSM calls).

    PERF_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/perf python -m scripts.perf_routes [--stops 200] [--json out.json]

PERF_DATABASE_URL is force-reset (all data dropped), so it refuses anything that does not look like a scratch database.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


def _configure() -> str:
    url = os.environ.get("PERF_DATABASE_URL", "")
    parts = urlsplit(url)
    if parts.hostname not in ("127.0.0.1", "localhost") and "perf" not in parts.path:
        sys.exit("PERF_DATABASE_URL must be a local database, or one whose name contains 'perf': it is wiped.")
    os.environ.update({
        "DATABASE_URL": url, "DIRECT_URL": url, "NODE_ENV": "development", "LOG_LEVEL": "error",
        "GEOCODING_PROVIDER": "none", "ROUTING_PROVIDER": "none", "EMAIL_PROVIDER": "console", "PAYMENT_STORES": "mock",
        "GOOGLE_MAPS_API_KEY": "", "STORAGE_DIR": str(ROOT / "tests" / "tmp-perf"),
    })
    for name, ch in (("JWT_ACCESS_SECRET", "a"), ("JWT_REFRESH_SECRET", "b"), ("FILE_SIGNING_SECRET", "c")):
        os.environ.setdefault(name, ch * 32)
    return url


class RoundTrips:
    """Counts round trips to the query engine; a batch counts once (one trip) and its statements separately."""

    def __init__(self):
        self.trips = 0
        self.statements = 0

    def install(self) -> None:
        from prisma.engine._query import AsyncQueryEngine

        counter = self

        def wrap(name: str):
            original = getattr(AsyncQueryEngine, name)

            async def counted(engine, *args, **kwargs):
                counter.trips += 1
                if name == "query":
                    body = json.loads(args[0]) if args else {}
                    counter.statements += len(body.get("batch", [])) or 1
                return await original(engine, *args, **kwargs)

            setattr(AsyncQueryEngine, name, counted)

        for name in ("query", "start_transaction", "commit_transaction", "rollback_transaction"):
            wrap(name)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stops", type=int, default=200)
    parser.add_argument("--json")
    args = parser.parse_args()
    _configure()

    scripts = Path(sys.executable).parent
    await asyncio.to_thread(subprocess.run, [str(scripts / "prisma"), "migrate", "reset", "--force", "--skip-generate", "--skip-seed"], cwd=ROOT,
                            env={**os.environ, "PATH": f"{scripts}{os.pathsep}{os.environ.get('PATH', '')}"}, check=True, capture_output=True)

    import httpx

    from app.db import connect, db, disconnect
    from app.main import create_app
    from app.services.subscription_service import ensure_default_plans

    counter = RoundTrips()
    counter.install()
    await connect()
    await ensure_default_plans()
    await db.plan.update_many(where={}, data={"deliveriesPerMonth": 1_000_000})  # measure the flows, not the plan limits
    app = create_app(run_jobs=False)
    # Planning normally runs in the worker process (P6b.2); here it runs inline as if this were the worker, so the
    # counts stay per flow (a polling worker in this process would add its own round trips to every flow).
    from app.services import jobs

    jobs.in_worker.set(True)
    results: list[dict] = []
    today = datetime.now(UTC).strftime("%Y-%m-%d")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://perf") as client:
        async def rider(email: str) -> dict:
            res = await client.post("/api/v1/auth/register", json={"fullName": "Perf Rider", "email": email, "password": "Perf-rider-pass-1!",
                                                                     "confirmPassword": "Perf-rider-pass-1!", "currency": "EUR"})
            assert res.status_code == 201, res.text
            body = res.json()["data"]
            await db.subscription.update_many(where={"userId": body["user"]["id"]},
                                              data={"status": "trialing", "currentPeriodEnd": datetime.now(UTC) + timedelta(days=14)})
            return {"Authorization": f"Bearer {body['accessToken']}"}

        async def flow(name: str, calls) -> list:
            trips, statements = counter.trips, counter.statements
            started = time.perf_counter()
            responses = []
            for method, path, body, *expect in calls:
                res = await client.request(method, path, headers=auth, **({"json": body} if body is not None else {}))
                assert res.status_code == expect[0] if expect else res.status_code < 400, (name, path, res.status_code, res.text[:300])
                responses.append(res)
            results.append({"flow": name, "requests": len(calls), "dbRoundTrips": counter.trips - trips,
                            "dbStatements": counter.statements - statements, "ms": round((time.perf_counter() - started) * 1000),
                            "responseKB": round(sum(len(r.content) for r in responses) / 1024, 1),
                            "wireKB": round(sum(r.num_bytes_downloaded for r in responses) / 1024, 1)})
            return responses

        def stops(prefix: str, n: int, located: bool) -> list[dict]:
            # A grid around Dublin city centre, about 100 m apart.
            return [{"trackingId": f"{prefix}-{i}", "address": {"raw": f"{i} Perf Street, Dublin"}, "serviceDate": today,
                     **({"location": {"latitude": 53.30 + (i // 20) * 0.001, "longitude": -6.30 + (i % 20) * 0.0015}} if located else {})}
                    for i in range(n)]

        # --- A rider with an n-stop route (located stops, as picked suggestions or scans give them) ---
        auth = await rider("perf-located@example.com")
        created = []
        for chunk in range(0, args.stops, 300):
            created += (await flow(f"Bulk add {min(300, args.stops - chunk)} stops", [("POST", "/api/v1/deliveries/bulk",
                                                                                        {"items": stops("P", args.stops, True)[chunk:chunk + 300]})]))[0].json()["data"]
        ids = [d["id"] for d in created]
        # deliveryIds is capped at 2,000 (a whole day); larger routes are built as "the whole day" (no ids).
        chosen = {"deliveryIds": ids} if len(ids) <= 2000 else {}
        route = (await flow(f"Build route ({len(ids)} stops)", [("POST", "/api/v1/routes/build", chosen)]))[0].json()["data"]
        await flow("Open Home", [("GET", f"/api/v1/rider/dashboard?date={today}", None), ("GET", f"/api/v1/routes/by-date?from={today}", None),
                                 ("GET", f"/api/v1/routes/leftover?date={today}", None),
                                 ("GET", f"/api/v1/deliveries?status=pending&dateFrom={today}&limit=100&sort=recent", None)])
        await flow("Open Route", [("GET", f"/api/v1/routes/{route['id']}", None)])
        await flow("Start route", [("POST", f"/api/v1/routes/{route['id']}/start", None)])
        first, middle = route["stops"][0]["delivery"]["id"], route["stops"][len(ids) // 2]["delivery"]["id"]
        await flow("Deliver Stop (arrive + deliver + reload route)", [("POST", f"/api/v1/deliveries/{first}/arrive", {}),
                                                                       ("POST", f"/api/v1/deliveries/{first}/deliver", {}),
                                                                       ("GET", f"/api/v1/routes/{route['id']}", None)])
        assert (await client.post(f"/api/v1/deliveries/{middle}/arrive", headers=auth, json={})).status_code == 200
        await flow("Deliver out of order (409: earlier stops open)", [("POST", f"/api/v1/deliveries/{middle}/deliver", {}, 409)])
        await flow("Optimize active route", [("POST", f"/api/v1/routes/{route['id']}/optimize", {})])
        await flow("Add Typed Stop", [("POST", "/api/v1/deliveries/manual",
                                       {"address": {"raw": "1 Typed Street, Dublin"}, "serviceDate": today,
                                        "location": {"latitude": 53.35, "longitude": -6.26}})])
        await flow("Routes list (completed)", [("GET", "/api/v1/routes", None)])

        # --- A second rider whose stops still need an address lookup (provider "none": every lookup misses) ---
        auth = await rider("perf-unlocated@example.com")
        created = []
        for chunk in range(0, args.stops, 300):
            created += (await client.post("/api/v1/deliveries/bulk", headers=auth,
                                          json={"items": stops("U", args.stops, False)[chunk:chunk + 300]})).json()["data"]
        await flow(f"Build route, addresses not yet looked up ({len(created)} stops)",
                   [("POST", "/api/v1/routes/build", {"deliveryIds": [d["id"] for d in created]} if len(created) <= 2000 else {})])

    await disconnect()
    width = max(len(r["flow"]) for r in results)
    print(f"{'flow':<{width}}  req  db trips  db stmts      ms  JSON KB  wire KB")
    for r in results:
        print(f"{r['flow']:<{width}}  {r['requests']:>3}  {r['dbRoundTrips']:>8}  {r['dbStatements']:>8}  {r['ms']:>6}  {r['responseKB']:>7}  {r['wireKB']:>7}")
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
