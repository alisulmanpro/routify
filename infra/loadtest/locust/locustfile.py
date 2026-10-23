"""Locust version of the Phase 8 scenarios (same API, same targets).

Staging only: `on_start` refuses any host that does not look like a staging
environment, so a Locust run can never reach production by accident.

    export LOADTEST_BASE_URL=https://routify-api-staging.onrender.com
    locust -f infra/loadtest/locust/locustfile.py --host "$LOADTEST_BASE_URL" \
           --tags route200 --users 100 --spawn-rate 20 --run-time 5m

Scenario (env LOCUST_SCENARIO): route200 (default) | dropout | duplicates | two_devices
"""
from __future__ import annotations

import itertools
import json
import os
import re
import uuid
from pathlib import Path

from locust import HttpUser, between, events, task

BASE_URL = os.environ.get("LOADTEST_BASE_URL", "")
RIDER_FILE = os.environ.get("RIDER_FILE", "infra/loadtest/data/riders.json")
STAGING_HOST_PATTERN = os.environ.get("STAGING_HOST_PATTERN", "staging")
ALLOW_LOCAL = os.environ.get("ALLOW_LOCAL") == "1"
PROD_HOSTS = [
    h.strip().lower()
    for h in os.environ.get(
        "PROD_HOSTS", "routify-api.onrender.com,api.routify.ie,www.routify.ie,routify.ie"
    ).split(",")
    if h.strip()
]
SCENARIO = os.environ.get("LOCUST_SCENARIO", "route200")
DEVICES = int(os.environ.get("DEVICES", "2"))

_counter = itertools.count()


def assert_staging(url: str) -> str:
    if not url:
        raise RuntimeError(
            "LOADTEST_BASE_URL is not set. Load tests may only run against a staging environment."
        )
    m = re.match(r"^https?://([^/:]+)", url)
    if not m:
        raise RuntimeError(f"LOADTEST_BASE_URL is not a valid http(s) URL: {url}")
    host = m.group(1).lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        if not ALLOW_LOCAL:
            raise RuntimeError(
                f"Refusing to load test {host}. Set ALLOW_LOCAL=1 for a local rehearsal "
                "(its numbers are not staging numbers)."
            )
        return url.rstrip("/")
    if any(host == p or host.endswith("." + p) for p in PROD_HOSTS):
        raise RuntimeError(f"Refusing to load test production host {host}. Staging only.")
    if not re.search(STAGING_HOST_PATTERN, host, re.IGNORECASE):
        raise RuntimeError(
            f"Refusing to load test {host}: the hostname does not look like a staging host "
            f"(pattern {STAGING_HOST_PATTERN!r}). Staging only."
        )
    return url.rstrip("/")


def load_riders():
    path = Path(RIDER_FILE)
    if not path.exists():
        raise RuntimeError(
            f"Rider file {path} not found. Create it first:\n"
            "  python3 infra/loadtest/scripts/seed_riders.py --riders 100 --stops 200\n"
            "Nothing was sent to the server."
        )
    riders = json.loads(path.read_text())
    if not riders:
        raise RuntimeError(f"Rider file {path} is empty.")
    return riders


RIDERS = load_riders()


class RiderUser(HttpUser):
    wait_time = between(1, 2)

    def on_start(self):
        self.base = assert_staging(self.host or BASE_URL)
        self.index = next(_counter)
        self.rider = None
        self.client.headers.update({"Accept": "application/json"})

    # ---------------------------------------------------------------- helpers
    def pick_rider(self):
        # In the two-devices scenario two consecutive users share one account.
        if SCENARIO == "two_devices":
            self.rider = RIDERS[(self.index // DEVICES) % len(RIDERS)]
        else:
            self.rider = RIDERS[self.index % len(RIDERS)]
        self.client.headers.update({"Authorization": f"Bearer {self.rider['accessToken']}"})
        return self.rider

    def api(self, method, path, body=None, headers=None, name=None, catch=False):
        with self.client.request(
            method, path, json=body, headers=headers, name=name, catch_response=catch
        ) as res:
            return res

    def open_route(self):
        res = self.api("GET", f"/api/v2/routes/{self.rider['routeId']}", name="open_route")
        try:
            data = res.json().get("data") or {}
        except Exception:
            return {}
        return data

    def next_stop(self, route):
        for stop in route.get("stops") or []:
            if stop.get("status") in ("pending", "in_progress"):
                return stop
        return None

    # -------------------------------------------------------------- scenarios
    @task
    def scenario_route200(self):
        if SCENARIO != "route200":
            return
        self.pick_rider()
        if not self.rider.get("routeId"):
            return
        self.api("GET", "/api/v2/rider/home", name="home")
        route = self.open_route()
        stop = self.next_stop(route)
        if stop:
            self.api(
                "POST",
                f"/api/v2/stops/{stop['id']}/events",
                {"type": "deliver", "allowSkip": True},
                headers={"Idempotency-Key": str(uuid.uuid4())},
                name="stop_event",
            )

    @task
    def scenario_dropout(self):
        """The phone sends the event, the network dies, the phone retries with the same key."""
        if SCENARIO != "dropout":
            return
        self.pick_rider()
        if not self.rider.get("routeId"):
            return
        route = self.open_route()
        stop = self.next_stop(route)
        if not stop:
            return
        key = str(uuid.uuid4())
        # The answer is thrown away (the phone is offline); the server may still get it.
        self.api(
            "POST",
            f"/api/v2/stops/{stop['id']}/events",
            {"type": "deliver", "allowSkip": True},
            headers={"Idempotency-Key": key},
            name="stop_event_dropped",
            catch=True,
        )
        self.api(
            "POST",
            f"/api/v2/stops/{stop['id']}/events",
            {"type": "deliver", "allowSkip": True},
            headers={"Idempotency-Key": key},
            name="stop_event",
        )

    @task
    def scenario_duplicates(self):
        """The same batch and the same event sent twice."""
        if SCENARIO != "duplicates":
            return
        self.pick_rider()
        items = [
            {
                "clientId": str(uuid.uuid4()),
                "address": {"raw": f"{i} Load Test Street, Dublin 1, D01 AB{i % 100:02d}"},
                "location": {"latitude": 53.30 + (i % 1000) / 10000, "longitude": -6.30 + (i % 1000) / 10000},
            }
            for i in range(10)
        ]
        self.api("POST", "/api/v2/deliveries/batch", {"items": items}, name="create_stops")
        self.api("POST", "/api/v2/deliveries/batch", {"items": items}, name="create_stops")
        if not self.rider.get("routeId"):
            return
        route = self.open_route()
        stop = self.next_stop(route)
        if stop:
            key = str(uuid.uuid4())
            for _ in range(2):
                self.api(
                    "POST",
                    f"/api/v2/stops/{stop['id']}/events",
                    {"type": "deliver", "allowSkip": True},
                    headers={"Idempotency-Key": key},
                    name="stop_event",
                )

    @task
    def scenario_two_devices(self):
        """Two devices on the same account deliver the same stop at the same time."""
        if SCENARIO != "two_devices":
            return
        self.pick_rider()
        if not self.rider.get("routeId"):
            return
        route = self.open_route()
        stop = self.next_stop(route)
        if stop:
            self.api(
                "POST",
                f"/api/v2/stops/{stop['id']}/events",
                {"type": "deliver", "allowSkip": True},
                headers={"Idempotency-Key": str(uuid.uuid4())},
                name="stop_event",
            )


@events.test_start.add_listener
def _check_target(environment, **_kwargs):
    assert_staging(environment.host or BASE_URL)
    print(f"Load test against {environment.host or BASE_URL} (scenario {SCENARIO})")
