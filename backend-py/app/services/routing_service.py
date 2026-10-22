"""Road travel-time / distance matrix for route optimisation.

ROUTING_PROVIDER=google (the default when GOOGLE_MAPS_API_KEY is set) uses Google's Distance Matrix
(Routes API computeRouteMatrix; enable "Routes API" for the key). ROUTING_PROVIDER=osrm uses an OSRM
server's /table API (OpenStreetMap roads, no key; the public demo server is for light use only).
If Google fails, OSRM is tried; if that fails too, planning falls back to straight-line distance.
ROUTING_PROVIDER=none always plans on straight-line distance.
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
# The demo server accepts up to 100 coordinates per table request; stay well below it.
MAX_POINTS = 60
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


async def _osrm_matrix(points: list[dict]) -> Optional[dict]:
    coords = ";".join(f"{p['longitude']:.6f},{p['latitude']:.6f}" for p in points)
    url = f"{env.OSRM_URL.rstrip('/')}/table/v1/driving/{coords}"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
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
    try:
        return await _google_matrix(points)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Google route matrix unavailable; trying OSRM", exc_info=True)
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
    if len(points) < 2 or len(points) > MAX_POINTS:
        return None
    try:
        result = await _lookup(points)
    except Exception:  # noqa: BLE001 - routing must never block planning
        log(logging.WARNING, "Road matrix unavailable; planning on straight-line distance", exc_info=True)
        return None
    return {"ids": ids, **result} if result else None
