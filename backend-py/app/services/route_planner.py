"""Pure route planner (unit-tested).

stops: [{id, latitude, longitude, addressKey}] (all geocoded).

Every route is ordered nearest-next: start → nearest stop → nearest of the remaining → … .
With a road `matrix` (metres and seconds between every pair of points, from routing_service) "nearest"
means shortest road distance; without one, straight-line (haversine) distance.
preference 'smart' additionally visits stops at the same address one after another; 'nearest_first'
and 'shortest' are kept for stored settings and behave the same as each other.

solve_open_path (exact / 2-opt optimisation) is kept for a possible "shortest total" mode but is not
used for ordering.
"""
from __future__ import annotations

from typing import Optional

from ..http import js_round, round2
from .geo import haversine_km

ROAD_FACTOR = 1.3  # straight-line → typical urban road distance
CLUSTER_KM = 0.05
EXACT_LIMIT = 12
START = "__start__"


def plan_route(*, origin: dict | None, stops: list[dict], preference: str, avg_speed_kmh: float = 25, service_minutes: float = 3,
               matrix: Optional[dict] = None) -> dict:
    """matrix: {"ids": [START?, stop ids...], "durations": [[s]], "distances": [[m]]} or None."""
    if not stops:
        return {"order": [], "legs": [], "distanceKm": 0, "durationMin": 0}

    nodes = _cluster(stops) if preference == "smart" else [{"latitude": s["latitude"], "longitude": s["longitude"], "members": [s]} for s in stops]
    road = _road_lookup(matrix)

    def cost(a: dict | None, b: dict) -> float:
        """Travel cost between two points (node or stop dicts); a=None is the start point."""
        a_id = START if a is None else a.get("id") or a["members"][0]["id"]
        b_id = b.get("id") or b["members"][0]["id"]
        if road and (hit := road(a_id, b_id)):
            return hit[0] / 1000  # road km
        if a is None:
            return haversine_km(origin, b) if origin else 0.0
        return haversine_km(a, b)

    n = len(nodes)
    # cost table: index 0 = start, 1..n = nodes
    table = [[0.0] * (n + 1) for _ in range(n + 1)]
    for j in range(n):
        table[0][j + 1] = cost(None, nodes[j])
        for i in range(n):
            if i != j:
                table[i + 1][j + 1] = cost(nodes[i], nodes[j])

    path = _nearest_neighbour(table, first=None)

    order: list[str] = []
    legs: list[dict] = []
    prev: dict | None = None
    distance_km = 0.0
    travel = 0.0
    for idx in path:
        for member in nodes[idx - 1]["members"]:
            hit = road(START if prev is None else prev["id"], member["id"]) if road else None
            if hit:
                leg_km, leg_min = round2(hit[0] / 1000), js_round(hit[1] / 60)
            elif prev is None and not origin:
                leg_km, leg_min = 0, 0
            else:
                leg_km = round2(haversine_km(prev or origin, member) * ROAD_FACTOR)
                leg_min = js_round((leg_km / avg_speed_kmh) * 60)
            legs.append({"id": member["id"], "distanceKm": leg_km, "durationMin": leg_min})
            order.append(member["id"])
            distance_km += leg_km
            travel += leg_min
            prev = member
    return {"order": order, "legs": legs, "distanceKm": round2(distance_km), "durationMin": travel + len(stops) * service_minutes}


def _road_lookup(matrix: Optional[dict]):
    if not matrix:
        return None
    index = {pid: i for i, pid in enumerate(matrix["ids"])}

    def lookup(a_id: str, b_id: str) -> Optional[tuple[float, float]]:
        i, j = index.get(a_id), index.get(b_id)
        if i is None or j is None:
            return None
        dist, dur = matrix["distances"][i][j], matrix["durations"][i][j]
        return None if dist is None or dur is None else (float(dist), float(dur))

    return lookup


def path_cost(table: list[list[float]], path: list[int]) -> float:
    total, prev = 0.0, 0
    for idx in path:
        total += table[prev][idx]
        prev = idx
    return total


def solve_open_path(table: list[list[float]]) -> list[int]:
    """Best visiting order of nodes 1..n starting at node 0 (no return). Works for asymmetric costs."""
    n = len(table) - 1
    if n <= 2:
        options = [[1, 2], [2, 1]] if n == 2 else [list(range(1, n + 1))]
        return min(options, key=lambda p: path_cost(table, p))
    if n <= EXACT_LIMIT:
        return _held_karp(table)
    best: list[int] | None = None
    for first in range(1, n + 1):
        candidate = _improve(table, _nearest_neighbour(table, first=first))
        if best is None or path_cost(table, candidate) < path_cost(table, best) - 1e-9:
            best = candidate
    return best or []


def _held_karp(table: list[list[float]]) -> list[int]:
    n = len(table) - 1
    full = 1 << n
    inf = float("inf")
    dp = [[inf] * n for _ in range(full)]
    parent = [[-1] * n for _ in range(full)]
    for j in range(n):
        dp[1 << j][j] = table[0][j + 1]
    for mask in range(full):
        row = dp[mask]
        for j in range(n):
            here = row[j]
            if here == inf or not mask & (1 << j):
                continue
            for k in range(n):
                if mask & (1 << k):
                    continue
                nxt = mask | (1 << k)
                value = here + table[j + 1][k + 1]
                if value < dp[nxt][k]:
                    dp[nxt][k] = value
                    parent[nxt][k] = j
    last = min(range(n), key=lambda j: dp[full - 1][j])
    path, mask = [], full - 1
    while last != -1:
        path.append(last + 1)
        prev = parent[mask][last]
        mask &= ~(1 << last)
        last = prev
    return path[::-1]


def _nearest_neighbour(table: list[list[float]], first: int | None) -> list[int]:
    n = len(table) - 1
    remaining = set(range(1, n + 1))
    path: list[int] = []
    here = 0
    if first is not None:
        path.append(first)
        remaining.discard(first)
        here = first
    while remaining:
        nxt = min(remaining, key=lambda j: (table[here][j], j))
        path.append(nxt)
        remaining.discard(nxt)
        here = nxt
    return path


def _improve(table: list[list[float]], path: list[int]) -> list[int]:
    """2-opt (segment reversal) and Or-opt (move 1-3 stops elsewhere) until neither helps."""
    best = path[:]
    best_cost = path_cost(table, best)
    n = len(best)
    for _ in range(50):
        improved = False
        for i in range(n - 1):
            for j in range(i + 1, n):
                cand = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                c = path_cost(table, cand)
                if c < best_cost - 1e-9:
                    best, best_cost, improved = cand, c, True
        for size in (1, 2, 3):
            for i in range(n - size + 1):
                seg = best[i:i + size]
                rest = best[:i] + best[i + size:]
                for j in range(len(rest) + 1):
                    if j == i:
                        continue
                    cand = rest[:j] + seg + rest[j:]
                    c = path_cost(table, cand)
                    if c < best_cost - 1e-9:
                        best, best_cost, improved = cand, c, True
                        break
        if not improved:
            break
    return best


def _cluster(stops: list[dict]) -> list[dict]:
    nodes: list[dict] = []
    for stop in stops:
        home = next((n for n in nodes if n["members"][0]["addressKey"] == stop["addressKey"] or haversine_km(n["members"][0], stop) <= CLUSTER_KM), None)
        if home:
            home["members"].append(stop)
        else:
            nodes.append({"latitude": stop["latitude"], "longitude": stop["longitude"], "members": [stop]})
    return nodes
