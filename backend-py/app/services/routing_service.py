"""Road data: travel-time / distance matrices for route optimisation, and road paths (route lines, navigation).

ROUTING_PROVIDER=osrm uses our own OSRM (infra/routing, OSRM_URL): matrices of any size up to its max-table-size, road
paths and turn-by-turn steps. ROUTING_PROVIDER=google uses Google's Routes API matrix (≤ 60 points; no paths) and our
OSRM after it when one is configured. ROUTING_PROVIDER=none: straight lines. The public OSRM demo server is never used
(P6b.6): it is not meant for production traffic.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

import httpx

from ..config import env
from ..logger import log
from . import google_usage

TIMEOUT = 10.0
# Google's matrix gets slow and costly fast (n² elements); our OSRM takes whole routes (P6b.3; its --max-table-size).
GOOGLE_MAX_POINTS = 60
OSRM_MAX_POINTS = 2500
# Google allows 625 elements (origins x destinations) per request, i.e. blocks of 25 x 25.
GOOGLE_BLOCK = 25
GOOGLE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"


def _waypoint(p: dict) -> dict:
    return {"waypoint": {"location": {"latLng": {"latitude": p["latitude"], "longitude": p["longitude"]}}}}


def _travel_mode() -> dict:
    # Riders on two wheels: Google's TWO_WHEELER mode has no routes in Ireland, and DRIVE sends a rider 3 km
    # round Dublin's one-way and bus-only streets to reach a stop 50 m away, so BICYCLE is the default.
    mode = env.ROUTING_TRAVEL_MODE
    return {"travelMode": mode, "routingPreference": "TRAFFIC_UNAWARE"} if mode == "DRIVE" else {"travelMode": mode}


async def _google_block(client: httpx.AsyncClient, points: list[dict], rows: list[int], cols: list[int],
                        durations: list[list], distances: list[list]) -> None:
    await google_usage.record("routes_matrix")
    res = await client.post(
        GOOGLE_MATRIX_URL,
        json={"origins": [_waypoint(points[i]) for i in rows], "destinations": [_waypoint(points[j]) for j in cols],
              **_travel_mode()},
        headers={"X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY or "",
                 "X-Goog-FieldMask": "originIndex,destinationIndex,status,condition,distanceMeters,duration"},
    )
    if res.status_code >= 400:
        raise RuntimeError(f"Google route matrix responded {res.status_code}: {res.text[:200]}")
    for el in res.json():
        # Zero values (index 0, distance 0) can be left out of the JSON.
        i, j = rows[el.get("originIndex", 0)], cols[el.get("destinationIndex", 0)]
        if i == j or el.get("condition") != "ROUTE_EXISTS":
            continue
        distances[i][j] = float(el.get("distanceMeters", 0))
        durations[i][j] = float(str(el.get("duration", "0s")).rstrip("s") or 0)


async def _google_matrix(points: list[dict]) -> Optional[dict]:
    n = len(points)
    durations: list[list] = [[0.0 if i == j else None for j in range(n)] for i in range(n)]
    distances: list[list] = [[0.0 if i == j else None for j in range(n)] for i in range(n)]
    blocks = [list(range(k, min(n, k + GOOGLE_BLOCK))) for k in range(0, n, GOOGLE_BLOCK)]
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        await asyncio.gather(*(_google_block(client, points, rows, cols, durations, distances) for rows in blocks for cols in blocks))
    return {"durations": durations, "distances": distances}


def _coords(points: list[dict]) -> str:
    return ";".join(f"{p['longitude']:.6f},{p['latitude']:.6f}" for p in points)


async def _osrm_matrix(points: list[dict]) -> Optional[dict]:
    if not env.OSRM_URL:
        return None
    url = f"{env.OSRM_URL}/table/v1/{env.OSRM_PROFILE}/{_coords(points)}"
    async with httpx.AsyncClient(timeout=TIMEOUT * 3) as client:
        res = await client.get(url, params={"annotations": "duration,distance"}, headers={"User-Agent": "routify-api"})
    if res.status_code >= 400:
        raise RuntimeError(f"OSRM responded {res.status_code}")
    body = res.json()
    if body.get("code") != "Ok":
        raise RuntimeError(f"OSRM table status {body.get('code')}")
    return {"durations": body["durations"], "distances": body["distances"]}


async def _no_matrix(points: list[dict]) -> Optional[dict]:
    return None


async def _google_then_osrm(points: list[dict]) -> Optional[dict]:
    if len(points) > GOOGLE_MAX_POINTS:
        return await _osrm_matrix(points)
    try:
        return await _google_matrix(points)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Google route matrix unavailable; trying our OSRM", exc_info=True)
        return await _osrm_matrix(points)


PROVIDERS: dict[str, Callable[[list[dict]], Awaitable[Optional[dict]]]] = {"google": _google_then_osrm, "osrm": _osrm_matrix, "none": _no_matrix}
# Tests never call the network unless they swap a fake in.
_lookup = PROVIDERS["none" if env.is_test else env.ROUTING_PROVIDER]


def set_matrix_for_tests(fn=None) -> None:
    global _lookup
    _lookup = fn or PROVIDERS["none" if env.is_test else env.ROUTING_PROVIDER]


async def road_matrix(ids: list[str], points: list[dict]) -> Optional[dict]:
    """{"ids", "durations" (s), "distances" (m)} between every pair of points, or None to fall back
    to straight-line planning (provider off, too many points, or the router is unreachable)."""
    limit = GOOGLE_MAX_POINTS if env.ROUTING_PROVIDER == "google" and not env.OSRM_URL else OSRM_MAX_POINTS
    if len(points) < 2 or len(points) > limit:
        return None
    try:
        result = await _lookup(points)
    except Exception:  # noqa: BLE001 - routing must never block planning
        log(logging.WARNING, "Road matrix unavailable; planning on straight-line distance", exc_info=True)
        return None
    return {"ids": ids, **result} if result else None


# ---- Road paths: route lines (P6b.4) and navigation (P6b.5), from our OSRM only ----

async def _osrm_route(points: list[dict], steps: bool) -> dict | None:
    if not env.OSRM_URL or len(points) < 2:
        return None
    url = f"{env.OSRM_URL}/route/v1/{env.OSRM_PROFILE}/{_coords(points)}"
    params = {"overview": "full", "geometries": "polyline", "steps": "true" if steps else "false"}
    async with httpx.AsyncClient(timeout=TIMEOUT * 3) as client:
        res = await client.get(url, params=params, headers={"User-Agent": "routify-api"})
    if res.status_code >= 400:
        raise RuntimeError(f"OSRM route responded {res.status_code}")
    body = res.json()
    if body.get("code") != "Ok" or not body.get("routes"):
        return None
    best = body["routes"][0]
    out = {
        # Google's encoded polyline format (precision 5): a few KB for a whole route.
        "path": best["geometry"],
        "legs": [{"distanceKm": round(leg["distance"] / 1000, 2), "durationMin": round(leg["duration"] / 60, 1)} for leg in best["legs"]],
        "distanceKm": round(best["distance"] / 1000, 2), "durationMin": round(best["duration"] / 60, 1),
    }
    if steps:
        out["steps"] = [{"distance": st["distance"], "duration": st["duration"], "name": st.get("name") or "",
                         "maneuver": {k: v for k, v in (st.get("maneuver") or {}).items() if k in ("type", "modifier", "location")}}
                        for leg in best["legs"] for st in leg.get("steps", [])]
    return out


_route = _osrm_route


def set_route_for_tests(fn=None) -> None:
    global _route
    _route = fn or _osrm_route


async def road_path(points: list[dict], *, steps: bool = False) -> dict | None:
    """The road path through `points` in order: {path (encoded polyline), legs, distanceKm, durationMin[, steps]}, or None
    when there is no road router (the app then draws straight lines). Never raises."""
    try:
        return await _route(points, steps)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Road path unavailable", exc_info=True)
        return None
