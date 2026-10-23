# Routing proof of concept: OSRM + VROOM (Phase 6a)

Self-hosted road routing for Ireland from OpenStreetMap (Geofabrik extract), and route optimisation with VROOM on top of
it. Local benchmark only: nothing in the API or the app uses it yet (that is Phase 6b).

| Service | Image (pinned) | Port (localhost only) | What it does |
|---|---|---|---|
| osrm | `ghcr.io/project-osrm/osrm-backend:v26.4.0` | 5000 | road distances/times, routes, tables, snapping (`/route`, `/table`, `/nearest`) |
| vroom | `ghcr.io/vroom-project/vroom-docker:v1.14.0` | 3000 | best stop order for one or more riders, using OSRM's road times |

Profile: **bicycle** by default (riders), set `OSRM_PROFILE=car` or `foot` in `.env` and run the prepare script again.

## Run it

Needs Docker, ~2 GB free disk, about 8 GB RAM while building the map (not while serving), and a download of ~420 MB.

```bash
cd infra/routing
cp .env.example .env                 # optional: OSRM_PROFILE=bicycle|car|foot
./scripts/prepare-ireland.sh         # download + osrm-extract/partition/customize (10-20 min, once)
docker compose up -d                 # osrm on :5000, vroom on :3000

# check
curl "http://127.0.0.1:5000/route/v1/bike/-6.2603,53.3498;-6.2595,53.3438?overview=false"
curl -s -X POST http://127.0.0.1:3000 -H 'Content-Type: application/json' -d @bench/sample-vroom.json | head -c 300

# benchmark (uses the backend's virtualenv to import the current planner unchanged)
../../backend-py/.venv/bin/python bench/benchmark.py --stops 200 --stops 1000 --stops 2000
docker compose down
```

The benchmark writes `bench/results/bench-<time>.json`. Copy its numbers into `perf.md` ("Phase 6a").

## What the benchmark measures

- 200 (or N) stops: random points in Dublin and inner suburbs (fixed seed), snapped to the nearest road by OSRM, plus a start in the city centre.
- **VROOM**: one rider on a bike, open route; VROOM's own loading/solving times and the request's wall time.
- **Current planner** (`backend-py/app/services/route_planner.py`, imported unchanged):
  - (a) as production runs it at that size: above 60 points it gets no road matrix, so straight-line costs;
  - (b) fed the same OSRM matrix, which separates "better data" from "better solver".
- **Distance**: every order is scored on the same OSRM road matrix, so the km compare like with like.
- **Memory**: `docker stats` of both containers at idle and the peak while solving.

## Updating the map

Geofabrik refreshes the extract daily. `REFRESH=1 ./scripts/prepare-ireland.sh` downloads it again and rebuilds; then `docker compose restart osrm`.
