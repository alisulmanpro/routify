"""Phase 6a benchmark: VROOM + OSRM vs the app's current Python planner, on realistic Dublin-area stops.

For N stops (default 200) from a start point in Dublin city centre:
  1. Stops: random points in the Dublin area (fixed seed), snapped to the nearest road by OSRM.
  2. OSRM table: road distance/time between every pair (also used to score every plan on real roads).
  3. VROOM: one rider (bike profile), open route from the start; solve time from VROOM's own timers and wall clock.
  4. Current planner (backend-py/app/services/route_planner.py, imported unchanged):
     a. as production runs it at this size: above 60 points it gets no road matrix -> straight-line costs;
     b. given the same OSRM matrix, to separate "better data" from "better solver".
  5. Memory: docker stats of the osrm and vroom containers (idle, and the peak sampled while solving).

Every order is scored on the same OSRM matrix (metres, seconds), so the distances compare like with like.

    cd infra/routing && docker compose up -d
    backend-py/.venv/bin/python infra/routing/bench/benchmark.py --stops 200 [--stops 1000 ...]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OSRM = os.environ.get("OSRM_URL", "http://127.0.0.1:5000")
VROOM = os.environ.get("VROOM_URL", "http://127.0.0.1:3000")
START = (53.3498, -6.2603)  # O'Connell Street, Dublin (lat, lng)
DUBLIN = (53.28, 53.40, -6.40, -6.13)  # lat min/max, lng min/max: the city and inner suburbs


def http_json(url: str, body: dict | None = None, timeout: float = 600) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def stops_in_dublin(n: int, seed: int) -> list[tuple[float, float]]:
    """n points on roads in the Dublin area: random, then snapped by OSRM /nearest (so every stop is reachable)."""
    rng = random.Random(seed)
    out: list[tuple[float, float]] = []
    while len(out) < n:
        lat, lng = rng.uniform(DUBLIN[0], DUBLIN[1]), rng.uniform(DUBLIN[2], DUBLIN[3])
        hit = http_json(f"{OSRM}/nearest/v1/bike/{lng:.6f},{lat:.6f}?number=1")
        if hit.get("code") == "Ok" and hit["waypoints"][0]["distance"] < 150:  # skip points in the sea, parks, the airport
            snapped = hit["waypoints"][0]["location"]
            out.append((snapped[1], snapped[0]))
    return out


def osrm_table(points: list[tuple[float, float]]) -> tuple[list[list[float]], list[list[float]], float]:
    coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in points)
    t0 = time.perf_counter()
    res = http_json(f"{OSRM}/table/v1/bike/{coords}?annotations=distance,duration")
    if res.get("code") != "Ok":
        raise RuntimeError(res)
    return res["distances"], res["durations"], time.perf_counter() - t0


def score(order: list[int], dist: list[list[float]], dur: list[list[float]]) -> tuple[float, float]:
    """Road km and minutes of an open route from point 0 through `order` (indices into the matrix)."""
    km = mins = 0.0
    prev = 0
    for i in order:
        km += (dist[prev][i] or 0) / 1000
        mins += (dur[prev][i] or 0) / 60
        prev = i
    return km, mins


class DockerMemory(threading.Thread):
    """Samples `docker stats` for the routing containers; keeps the peak per container (MiB)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.peak: dict[str, float] = {}
        self.running = True

    @staticmethod
    def sample() -> dict[str, float]:
        out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}"], capture_output=True, text=True, check=False).stdout
        mem = {}
        for line in out.splitlines():
            name, usage = line.split(" ", 1)
            if "osrm" not in name and "vroom" not in name:
                continue
            value = usage.split("/")[0].strip()
            number = float("".join(ch for ch in value if ch.isdigit() or ch == "."))
            mem["osrm" if "osrm" in name else "vroom"] = number * {"GiB": 1024, "MiB": 1, "KiB": 1 / 1024}.get(value.lstrip("0123456789.").strip(), 1)
        return mem

    def run(self):
        while self.running:
            for k, v in self.sample().items():
                self.peak[k] = max(self.peak.get(k, 0), v)


def vroom_solve(points: list[tuple[float, float]]) -> dict:
    """One rider on a bike from the start, every stop a job, open route (no return)."""
    body = {
        "vehicles": [{"id": 1, "profile": "bike", "start": [points[0][1], points[0][0]]}],
        "jobs": [{"id": i, "location": [lng, lat], "service": 180} for i, (lat, lng) in enumerate(points) if i > 0],
        "options": {"g": False},
    }
    t0 = time.perf_counter()
    res = http_json(VROOM, body)
    wall = time.perf_counter() - t0
    if res.get("code") != 0:
        raise RuntimeError(res)
    steps = [s for s in res["routes"][0]["steps"] if s["type"] == "job"]
    timers = res["summary"].get("computing_times", {})
    return {"order": [s["id"] for s in steps], "wall_s": wall, "unassigned": len(res.get("unassigned", [])),
            "loading_ms": timers.get("loading"), "solving_ms": timers.get("solving")}


def python_planner(points, dist, dur, *, with_matrix: bool, preference: str) -> dict:
    sys.path.insert(0, str(ROOT / "backend-py"))
    for name, value in (("NODE_ENV", "test"), ("DATABASE_URL", "postgresql://x/y"), ("JWT_ACCESS_SECRET", "a" * 32),
                        ("JWT_REFRESH_SECRET", "b" * 32), ("FILE_SIGNING_SECRET", "c" * 32)):
        os.environ.setdefault(name, value)
    from app.services.route_planner import START as PSTART
    from app.services.route_planner import plan_route

    stops = [{"id": f"s{i}", "latitude": lat, "longitude": lng, "addressKey": f"s{i}"} for i, (lat, lng) in enumerate(points) if i > 0]
    matrix = None
    if with_matrix:
        matrix = {"ids": [PSTART] + [s["id"] for s in stops], "distances": dist, "durations": dur}
    t0 = time.perf_counter()
    plan = plan_route(origin={"latitude": points[0][0], "longitude": points[0][1]}, stops=stops, preference=preference, matrix=matrix)
    wall = time.perf_counter() - t0
    return {"order": [int(sid[1:]) for sid in plan["order"]], "wall_s": wall}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stops", type=int, action="append", help="stop counts (repeatable); default 200")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--preference", default="smart", choices=["smart", "shortest", "nearest_first"])
    args = parser.parse_args()
    sizes = args.stops or [200]

    results = []
    idle = DockerMemory.sample()
    for n in sizes:
        print(f"--- {n} stops ---", flush=True)
        points = [START, *stops_in_dublin(n, args.seed)]
        dist, dur, table_s = osrm_table(points)
        mem = DockerMemory()
        mem.start()
        vroom = vroom_solve(points)
        mem.running = False
        mem.join()
        prod = python_planner(points, dist, dur, with_matrix=n + 1 <= 60, preference=args.preference)
        fed = python_planner(points, dist, dur, with_matrix=True, preference=args.preference)
        row = {"stops": n, "osrm_table_s": round(table_s, 2), "peak_mem_mib": {k: round(v) for k, v in mem.peak.items()}}
        for name, plan in (("vroom", vroom), ("python_as_in_production", prod), ("python_with_osrm_matrix", fed)):
            assert sorted(plan["order"]) == list(range(1, n + 1)), f"{name} lost stops"
            km, mins = score(plan["order"], dist, dur)
            row[name] = {"solve_s": round(plan["wall_s"], 2), "road_km": round(km, 1), "ride_min": round(mins)}
            if name == "vroom":
                row[name] |= {"vroom_solving_ms": vroom["solving_ms"], "vroom_loading_ms": vroom["loading_ms"], "unassigned": vroom["unassigned"]}
        base = row["python_as_in_production"]["road_km"]
        row["vroom_vs_production_km_pct"] = round((row["vroom"]["road_km"] - base) / base * 100, 1) if base else None
        results.append(row)
        print(json.dumps(row, indent=2), flush=True)

    out = Path(__file__).parent / "results"
    out.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (out / f"bench-{stamp}.json").write_text(json.dumps({"idle_mem_mib": idle, "seed": args.seed, "preference": args.preference,
                                                          "results": results}, indent=2))
    print(f"idle memory (MiB): {idle}")
    print(f"saved bench/results/bench-{stamp}.json")


if __name__ == "__main__":
    main()
