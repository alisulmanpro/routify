"""Route optimisation providers (P6b.1).

- vroom: our VROOM (infra/routing, VROOM_URL), which orders the stops on our OSRM's road times. The API only waits on
  HTTP here, so it may call it directly.
- python: the built-in planner (route_planner.plan_route) on the best road matrix available (our OSRM, any size;
  Google ≤ 60 points; else straight lines). It is CPU work: it runs in the worker process (jobs), or inline only for a
  handful of stops (PLANNER_INLINE_MAX, a few ms).

plan() tries vroom and falls back to python when VROOM is not configured, down or fails, so a route can always be planned.
Every provider returns the same shape: {order, legs [{id, distanceKm, durationMin}], distanceKm, durationMin, optimization}.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..config import env
from ..http import js_round, round2
from ..logger import log
from . import jobs, routing_service
from .google_usage import current_rider
from .route_planner import START, plan_route

VROOM_TIMEOUT = 300.0


def _vroom_url() -> str:
    return env.VROOM_URL


async def _post_vroom(body: dict) -> dict:
    async with httpx.AsyncClient(timeout=VROOM_TIMEOUT) as client:
        res = await client.post(_vroom_url(), json=body)
    if res.status_code >= 400:
        raise RuntimeError(f"VROOM responded {res.status_code}: {res.text[:200]}")
    return res.json()


async def vroom_plan(origin: dict | None, stops: list[dict], service_minutes: float) -> dict | None:
    """One rider, an open route from `origin` (else the first stop), every stop a job. None when VROOM is not set up."""
    if not _vroom_url() or not stops:
        return None
    start = origin or stops[0]
    body = {
        "vehicles": [{"id": 1, "profile": env.VROOM_PROFILE, "start": [start["longitude"], start["latitude"]]}],
        "jobs": [{"id": i, "location": [s["longitude"], s["latitude"]], "service": int(service_minutes * 60)} for i, s in enumerate(stops)],
        # g: route geometry, which also makes VROOM report road distances per step.
        "options": {"g": True},
    }
    res = await _post_vroom(body)
    if res.get("code") != 0 or not res.get("routes"):
        raise RuntimeError(f"VROOM could not solve: code {res.get('code')} {res.get('error', '')}")
    steps = [st for st in res["routes"][0]["steps"] if st["type"] == "job"]
    if res.get("unassigned"):
        raise RuntimeError(f"VROOM left {len(res['unassigned'])} stops out")
    legs, prev_m, prev_s = [], 0.0, 0.0
    for st in steps:
        meters, seconds = float(st.get("distance", 0)), float(st.get("duration", 0))
        legs.append({"id": stops[st["id"]]["id"], "distanceKm": round2((meters - prev_m) / 1000), "durationMin": js_round((seconds - prev_s) / 60)})
        prev_m, prev_s = meters, seconds
    travel = sum(leg["durationMin"] for leg in legs)
    return {"order": [leg["id"] for leg in legs], "legs": legs, "distanceKm": round2(prev_m / 1000),
            "durationMin": travel + len(stops) * service_minutes, "optimization": "road"}


async def python_plan(origin: dict | None, stops: list[dict], preference: str, avg_speed_kmh: float, service_minutes: float) -> dict:
    """The built-in planner on the best road matrix available. CPU-bound: only in the worker or for tiny routes."""
    points = ([origin] if origin else []) + [{"latitude": s["latitude"], "longitude": s["longitude"]} for s in stops]
    ids = ([START] if origin else []) + [s["id"] for s in stops]
    matrix = await routing_service.road_matrix(ids, points) if stops else None
    plan = await asyncio.to_thread(plan_route, origin=origin, preference=preference, avg_speed_kmh=avg_speed_kmh,
                                   service_minutes=service_minutes, stops=stops, matrix=matrix)
    return {**plan, "optimization": "road" if matrix else "straight_line"}


@jobs.handler("plan")
async def _plan_job(payload: dict) -> dict:
    return await python_plan(payload["origin"], payload["stops"], payload["preference"], payload["avgSpeedKmh"], payload["serviceMinutes"])


async def plan(origin: dict | None, stops: list[dict], preference: str, settings: dict) -> dict:
    """The best stop order available right now, without heavy CPU in the API process."""
    avg_speed, service = settings["route"]["avgSpeedKmh"], settings["route"]["stopServiceMinutes"]
    # VROOM minimises time over the whole route; "nearest first" is a deliberate greedy order, so it stays built in.
    if preference != "nearest_first" and len(stops) >= 2:
        try:
            result = await vroom_plan(origin, stops, service)
            if result:
                return result
        except Exception:  # noqa: BLE001 - the built-in planner below always works
            log(logging.WARNING, "VROOM unavailable; using the built-in planner", exc_info=True)
    if jobs.in_worker.get() or len(stops) <= env.PLANNER_INLINE_MAX:
        return await python_plan(origin, stops, preference, avg_speed, service)
    payload: dict[str, Any] = {"origin": origin, "stops": stops, "preference": preference, "avgSpeedKmh": avg_speed, "serviceMinutes": service}
    return await jobs.run_and_wait("plan", payload, rider_id=current_rider.get(), timeout_s=env.PLAN_JOB_WAIT_SECONDS)
