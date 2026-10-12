"""Pure route planner (unit-tested).

stops: [{id, latitude, longitude, addressKey}] (all geocoded).
preference: 'nearest_first' (greedy) | 'shortest' (greedy + 2-opt) | 'smart' (same-address grouping + 2-opt).
Distances are straight-line × 1.3, NOT turn-by-turn road routing.
"""
from __future__ import annotations

from ..http import js_round, round2
from .geo import haversine_km

ROAD_FACTOR = 1.3  # straight-line → typical urban road distance
CLUSTER_KM = 0.05


def plan_route(*, origin: dict | None, stops: list[dict], preference: str, avg_speed_kmh: float = 25, service_minutes: float = 3) -> dict:
    if not stops:
        return {"order": [], "legs": [], "distanceKm": 0, "durationMin": 0}

    nodes = _cluster(stops) if preference == "smart" else [{"latitude": s["latitude"], "longitude": s["longitude"], "members": [s]} for s in stops]
    start = origin or {"latitude": nodes[0]["latitude"], "longitude": nodes[0]["longitude"]}
    d = haversine_km

    # Greedy nearest neighbour from the start point.
    remaining = list(range(len(nodes)))
    path: list[int] = []
    here = start
    while remaining:
        best = 0
        for i in range(1, len(remaining)):
            if d(here, nodes[remaining[i]]) < d(here, nodes[remaining[best]]):
                best = i
        idx = remaining.pop(best)
        path.append(idx)
        here = nodes[idx]

    if preference != "nearest_first" and len(path) > 2:
        path = _two_opt(path, nodes, start, d)

    order: list[str] = []
    legs: list[dict] = []
    prev = origin or None
    distance_km = 0.0
    for idx in path:
        for member in nodes[idx]["members"]:
            leg = round2(d(prev, member) * ROAD_FACTOR) if prev else 0
            legs.append({"id": member["id"], "distanceKm": leg, "durationMin": js_round((leg / avg_speed_kmh) * 60)})
            order.append(member["id"])
            distance_km += leg
            prev = member
    travel = sum(leg["durationMin"] for leg in legs)
    return {"order": order, "legs": legs, "distanceKm": round2(distance_km), "durationMin": travel + len(stops) * service_minutes}


def _cluster(stops: list[dict]) -> list[dict]:
    nodes: list[dict] = []
    for stop in stops:
        home = next((n for n in nodes if n["members"][0]["addressKey"] == stop["addressKey"] or haversine_km(n["members"][0], stop) <= CLUSTER_KM), None)
        if home:
            home["members"].append(stop)
        else:
            nodes.append({"latitude": stop["latitude"], "longitude": stop["longitude"], "members": [stop]})
    return nodes


def _two_opt(path: list[int], nodes: list[dict], start: dict, d) -> list[int]:
    seq: list = [None, *path]  # index 0 is the fixed start point
    at = lambda i: start if i == 0 else nodes[seq[i]]  # noqa: E731
    k = len(seq) - 1
    for _ in range(60):
        improved = False
        for i in range(1, k):
            for j in range(i + 1, k + 1):
                a, b, c = at(i - 1), at(i), at(j)
                nxt = at(j + 1) if j < k else None
                before = d(a, b) + (d(c, nxt) if nxt else 0)
                after = d(a, c) + (d(b, nxt) if nxt else 0)
                if after + 1e-9 < before:
                    seq[i:j + 1] = seq[i:j + 1][::-1]
                    improved = True
        if not improved:
            break
    return seq[1:]
