"""Phase 6b: providers (VROOM / built-in planner), the optimise job, fallbacks, no 60-point cap on our OSRM."""
from __future__ import annotations

import asyncio
import dataclasses

from app.db import db
from app.services import optimizer, routing_service

from .test_api import rider
from .test_v2 import item, route_with_stops


async def wait_for_job(client, auth, job_id: str) -> dict:
    for _ in range(200):
        job = (await client.get(f"/api/v2/jobs/{job_id}", headers=auth)).json()["data"]
        if job["status"] in ("done", "failed"):
            return job
        await asyncio.sleep(0.05)
    raise AssertionError("job did not finish")


async def plan_jobs_of(rider_id: str) -> int:
    return await db.job.count(where={"riderId": rider_id, "type": "plan"})


async def test_optimise_is_a_background_job_the_app_polls(client):
    body, auth = await rider(client, "p6-job@example.com")
    built = await route_with_stops(client, auth, 15)
    queued = await client.post(f"/api/v2/routes/{built['id']}/optimize", headers=auth, json={"origin": {"latitude": 53.32, "longitude": -6.28}})
    assert queued.status_code == 202, queued.text
    job = queued.json()["data"]
    assert job["type"] == "optimize_route" and job["status"] in ("queued", "running", "done")
    # Asking again while it waits returns the same job (no second optimisation).
    again = await client.post(f"/api/v2/routes/{built['id']}/optimize", headers=auth, json={})
    assert again.json()["data"]["id"] == job["id"] or again.status_code == 202

    done = await wait_for_job(client, auth, job["id"])
    assert done["status"] == "done" and done["result"]["routeId"] == built["id"] and done["result"]["stops"] == 15
    route = (await client.get(f"/api/v2/routes/{built['id']}", headers=auth)).json()["data"]
    assert route["origin"] == {"latitude": 53.32, "longitude": -6.28}

    _, stranger = await rider(client, "p6-job-stranger@example.com")
    assert (await client.get(f"/api/v2/jobs/{job['id']}", headers=stranger)).status_code == 404
    assert (await client.post(f"/api/v2/routes/{built['id']}/optimize", headers=stranger, json={})).status_code == 404


async def test_vroom_orders_the_route_and_the_api_only_waits_on_http(client, monkeypatch):
    body, auth = await rider(client, "p6-vroom@example.com")
    seen = {}

    async def fake_vroom(request: dict) -> dict:
        seen["request"] = request
        # VROOM's answer: the jobs in reverse order, cumulative road distance/time per step.
        jobs = list(reversed(request["jobs"]))
        steps = [{"type": "start"}] + [{"type": "job", "id": j["id"], "distance": 900 * (k + 1), "duration": 180 * (k + 1)} for k, j in enumerate(jobs)]
        return {"code": 0, "routes": [{"steps": steps}], "unassigned": []}

    monkeypatch.setattr(optimizer, "_vroom_url", lambda: "http://vroom.test")
    monkeypatch.setattr(optimizer, "_post_vroom", fake_vroom)
    created = (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(i) for i in range(20)]})).json()["data"]["stops"]
    res = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": [s["id"] for s in created]})
    assert res.status_code == 201, res.text
    route = res.json()["data"]
    assert route["optimization"] == "road" and route["distanceKm"] == 18.0
    sent = [j["id"] for j in seen["request"]["jobs"]]
    assert [s["delivery"]["id"] for s in route["stops"]][:2] == [created[sent[-1]]["id"], created[sent[-2]]["id"]]
    assert seen["request"]["vehicles"][0]["profile"] == "bike" and seen["request"]["options"]["g"] is True
    assert await plan_jobs_of(body["user"]["id"]) == 0, "VROOM answered: no planning job"


async def test_when_vroom_is_down_the_built_in_planner_runs_in_the_worker(client, monkeypatch):
    body, auth = await rider(client, "p6-vroom-down@example.com")
    # A VROOM address nothing listens on.
    monkeypatch.setattr(optimizer, "_vroom_url", lambda: "http://127.0.0.1:9")
    built = await route_with_stops(client, auth, 20, start=False)
    assert built["optimization"] == "straight_line" and len(built["stops"]) == 20
    # The 20-stop plan was done by the worker (a "plan" job), not in the API process.
    assert await plan_jobs_of(body["user"]["id"]) == 1
    assert (await db.job.find_first(where={"riderId": body["user"]["id"], "type": "plan"})).status == "done"


async def test_when_osrm_is_down_too_planning_falls_back_to_straight_lines(client, monkeypatch):
    _, auth = await rider(client, "p6-osrm-down@example.com")

    async def osrm_down(points):
        raise ConnectionError("OSRM is down")

    monkeypatch.setattr(optimizer, "_vroom_url", lambda: "")
    routing_service.set_matrix_for_tests(osrm_down)
    try:
        built = await route_with_stops(client, auth, 12, start=False)
        assert built["optimization"] == "straight_line" and len(built["stops"]) == 12
    finally:
        routing_service.set_matrix_for_tests()


async def test_tiny_routes_are_planned_inline(client, monkeypatch):
    body, auth = await rider(client, "p6-inline@example.com")
    monkeypatch.setattr(optimizer, "_vroom_url", lambda: "")
    await route_with_stops(client, auth, 5, start=False)
    assert await plan_jobs_of(body["user"]["id"]) == 0


async def test_our_osrm_has_no_60_point_cap(client, monkeypatch):
    calls = []

    async def table(points):
        calls.append(len(points))
        n = len(points)
        return {"durations": [[0.0] * n for _ in range(n)], "distances": [[0.0] * n for _ in range(n)]}

    points = [{"latitude": 53.3 + i / 1000, "longitude": -6.3} for i in range(201)]
    ids = [str(i) for i in range(201)]
    routing_service.set_matrix_for_tests(table)
    try:
        monkeypatch.setattr(routing_service, "env", dataclasses.replace(routing_service.env, ROUTING_PROVIDER="osrm", OSRM_URL="http://osrm.test"))
        assert await routing_service.road_matrix(ids, points) is not None
        # Google's matrix keeps its cap (n² billed elements).
        monkeypatch.setattr(routing_service, "env", dataclasses.replace(routing_service.env, ROUTING_PROVIDER="google", OSRM_URL=""))
        assert await routing_service.road_matrix(ids, points) is None
        assert calls == [201]
    finally:
        routing_service.set_matrix_for_tests()
