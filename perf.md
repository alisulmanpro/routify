# perf.md — Performance measurements

## How these numbers were measured

- **Tool:** `backend-py/scripts/perf_routes.py`. It drives the real FastAPI app in-process, with every middleware included, and counts each round trip to the Prisma query engine: queries, batches and transaction begin/commit. It also counts the SQL statements inside batches, the wall time per flow and the response size.
- **Timing middleware:** since P0.7 every API response carries `Server-Timing: app;dur=…, db;dur=…;desc="N queries"` and the access log has `responseTime`, `dbQueries`, `dbMs`. The Phase 1 numbers below were taken before it existed, with the harness, which counts the same things from outside the app.
- **Database:** a local PostgreSQL 18 container, wiped before each run. Local round trips cost about 0.1 ms, so the **ms column is mostly server CPU**. On a hosted database every DB round trip adds its network latency on top. That latency is about 1–2 ms on Render Ohio ↔ Neon us-east-2, and about 250 ms from a laptop in Pakistan to Neon. The **DB trips column** is the number that latency multiplies.
- **Map providers:** set to `none`, so the numbers include no Google or OSM calls. Stops are created with a location, as picked suggestions, pins and scans give them. The last flow uses stops without a location: every lookup misses, and each stop is saved as `not_found`.
- **Before** = `origin/main` (`4b95abf`). **Mid** = after P1.1–P1.4. **After** = branch `phase-1-backend-fast` after P1.13. Timings are the median of 3 runs; DB counts are identical in every run.
- **Wire KB:** what crosses the network with `Accept-Encoding: gzip` (P1.4). The synthetic stops are very similar to each other, so they compress better than real data would. Expect roughly 5–10× on real routes, not 25×.

Reproduce:

```bash
docker run -d --name dp-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18-alpine
cd backend-py
PERF_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/perf python -m scripts.perf_routes --stops 200
```

## Baseline (P0.11) — the four rider flows, 200-stop route, 2026-10-23

Same harness and local database as below, on branch `final-issues` (every phase up to P7.3). Planning runs inline in
the harness (as in the worker), so the counts are per flow. Real network time on Neon = **DB trips × latency** (≈ 1–2 ms
from Render Ohio): read it per request from the `Server-Timing` header.

| Flow | Requests | DB trips | DB statements | ms (local) | Wire KB (gzip) |
|---|---:|---:|---:|---:|---:|
| **Open Home** (v1: dashboard + by-date + leftover + pending list) | 4 | 10 | 10 | 307 | 4.7 |
| **Open Route** | 1 | 3 | 3 | 61 | 5.2 |
| **Deliver Stop** (v1: arrive + deliver + reload route) | 3 | 14 | 14 | 233 | 6.4 |
| **Add Typed Stop** | 1 | 9 | 7 | 71 | 0.5 |
| Build route, addresses not yet looked up (200 stops) | 1 | **18** (217 after Phase 1) | 16 | 529 | 3.9 |

- The app uses v2 since Phase 3: Home is **1 request** (`GET /v2/rider/home`) and Deliver is **1 request** (`POST /v2/stops/{id}/events`), see "Phase 3".
- Deliver Stop has two more DB trips than after Phase 1 (12 → 14): the `stop_events` audit row (P4.5).
- The address-lookup build dropped from 217 to 18 trips: the geocode cache is now read once per batch (ISSUE-07).
- On the Neon dev branch these flows have **not** been re-timed: see owner.md (run the seed script, open the app, read `Server-Timing`).

## Phase 1 — 200-stop route (one rider)

| Flow | Req | DB trips before → P1.1–1.4 → after | DB statements before → after | ms before → after | Wire KB before → after |
|---|---:|---|---|---|---|
| Bulk add 200 stops | 1 | 13 → 12 → **12** | 11 → **10** | 343 → **266** | 106.6 → **3.8** |
| Build route (200 stops) | 1 | 12 → 10 → **15** | 211 → **13** | 1206 → **1075** | 123.7 → **5.2** |
| **Open Home** (dashboard + by-date + leftover + pending list) | 4 | 17 → 9 → **10** | 17 → **10** | 268 → **168** | 76.6 → **4.8** |
| **Open Route** | 1 | 5 → 3 → **3** | 5 → **3** | 77 → **78** | 123.7 → **5.2** |
| Start route | 1 | 8 → 6 → **9** | 8 → **7** | 94 → **108** | 123.7 → **5.2** |
| **Deliver Stop** (arrive + deliver + reload route) | 3 | 18 → 12 → **12** | 18 → **12** | 174 → **156** | 124.9 → **6.5** |
| Deliver out of order (409, 99 earlier stops open) | 1 | 4 → 2 → **2** | 4 → **2** | 45 → **17** | 3.7 → **0.1** |
| Optimize active route | 1 | 13 → 11 → **17** | 212 → **15** | 919 → **748** | 123.8 → **5.3** |
| **Add Typed Stop** | 1 | 11 → 9 → **9** | 9 → **7** | 76 → **68** | 0.5 → **0.5** |
| Routes list (completed) | 1 | 3 → 1 → **1** | 3 → **1** | 25 → **13** | 0.0 → **0.0** |
| Build route, addresses not yet looked up (200 stops) | 1 | 612 → 610 → **217** | 811 → **215** | 4059 → **1318** | 122.5 → **3.9** |

## Phase 1 — 1,000-stop route (one run each)

| Flow | DB trips before → after | DB statements before → after | ms before → after | Wire KB before → after |
|---|---|---|---|---|
| Build route (1,000 stops) | 12 → **15** | 1,011 → **13** | 13,653 → **9,945** | 618 → **23** |
| Open Home | 17 → **10** | 17 → **10** | 632 → **300** | 159 → **12** |
| Open Route | 5 → **3** | 5 → **3** | 490 → **216** | 618 → **23** |
| Deliver Stop (3 requests) | 18 → **12** | 18 → **12** | 525 → **215** | 620 → **25** |
| Deliver out of order (409) | 4 → **2** | 4 → **2** | 140 → **25** | 18.9 → **0.1** |
| Optimize active route | 14 → **17** | 1,013 → **15** | 12,498 → **9,048** | 618 → **24** |
| Build, addresses not yet looked up | 3,012 → **1,017** | 4,011 → **1,015** | 22,408 → **5,340** | 612 → **17** |

## What changed and what is left

- **Every request:** 2 fewer DB round trips. The general rate limit is now counted in memory (P1.1), and the account check is cached for 30 s (P1.2).
- **Route writes no longer grow with the number of stops.** Building or optimizing a route used to send one UPDATE per stop (211 statements for 200 stops, 1,013 for 1,000). Now the whole route is written with about 13–15 statements, inside one transaction (P1.5, P1.6). Build, optimize and start make 3–6 *more* round trips than before: transaction begin/commit, the rider lock and the "stops still free" check. That is the cost of all-or-nothing writes.
- **Geocode saves:** 2 round trips per stop became 1 statement for the whole route (P1.7). The remaining ~1 trip per stop in "addresses not yet looked up" is the geocode-cache read, one per address (ISSUE-07).
- **Responses:** route-sized JSON is 20–25× smaller on the wire with gzip (P1.4). The JSON itself is unchanged: about 0.6 KB per stop, so 1,000 stops are 618 KB before compression.
- **Still slow: building and optimizing large routes.** About 10 s at 1,000 stops, and that time is in the Python optimiser (`route_planner.py`), not the database. This is Phase 6 (OSRM + VROOM in a worker). Until then a large build blocks the single API process.
- **Open Route / Deliver** still re-download the whole route (≈ 125 KB of JSON at 200 stops). Phase 2 (`/v2` lean routes + deltas) and Phase 3 (app cache) fix this.

## Phase 3 — Requests per rider action (app)

Counted from the app's code paths: every request the screens and components on the way make. "Before" is
`origin/main`; "after" is branch `phase-3-app-speed`. Route sizes are for the 200-stop route.

| Action | Before (v1 app) | After (Phase 3) |
|---|---|---|
| **Open Home** | **6**: `/rider/dashboard`, `/routes/by-date`, `/routes/leftover`, `/deliveries?status=pending&limit=100` (up to 100 whole stops, only to count them), `/subscriptions/me` and `/subscriptions/store` (Free-trial chip). Every time Home was shown. | **1**: `GET /api/v2/rider/home` (counts only, includes the plan status). Back on Home within 30 s with nothing changed: **0**. Riders without a plan also fetch `/subscriptions/store` at most once a day for the chip. The saved copy is drawn first, also after a restart or offline. |
| **Deliver Stop** (stop screen → Delivered) | **5**: `GET /routes/current` (whole route, to check the order), `POST …/arrive`, `POST …/deliver`, `GET /routes/{id}` (whole route, "is it complete?"), then the route map reloaded the whole route on return. That is 3 full route downloads (≈ 125 KB of JSON each at 200 stops). | **1**: `POST /api/v2/stops/{id}/events` (arrival recorded by the server; the answer carries the route's progress, next stop and "completed"). Going back to the route: **0** (the saved route is updated from that answer). |
| Deliver from a list ("Mark as delivered?") | 2 (`arrive` + `deliver`) | 1 (`POST /api/v2/stops/{id}/events`) |
| Open a route (by id) | 1 whole route (≈ 125 KB JSON) | 1 `GET /api/v2/routes/{id}`: light stops, gzip ≈ 5 KB. Unchanged since last time: **304, no body** |
| Add a typed stop | 1 `POST /deliveries/manual` (a retry could duplicate it) | 1 `POST /api/v2/deliveries/batch` (client id: a retry never duplicates) |
| Proof photo | full camera photo (often 3–5 MB) | resized to ≤ 1600 px JPEG 0.7 (a few hundred KB) |
| While the app is open | service-area check every 15 min (GPS + API) | none; only at launch / return to the foreground, at most every 6 h |

Opening a stop's details is still 1 v1 request (`GET /deliveries/{id}`, which has the phone, notes and photo). App launch
costs `GET /auth/me` and `GET /config` (version check), as before.

### Timings to measure on a real phone

I could not measure these: I have no physical device. The only run was on an Android emulator on a laptop, and its
timings are not representative. Please measure on a mid-range Android phone (and an iPhone if possible) with the
200-stop route, release-like build (`eas build --profile preview`), and fill in the table.

How: a screen recording at 60 fps (count frames from tap to change) or a stopwatch averaged over 3 tries. For smoothness,
use Settings → Developer options → "Profile HWUI rendering" (bars) or the React Native perf monitor (dev menu, dev build
only). For 4G, use Developer options → "Network speed" if available, or a real 4G connection away from Wi-Fi.

| # | What | How to do it | Target (task.md P8) | Wi-Fi | 4G |
|---|---|---|---|---|---|
| 1 | Cold start → Home with numbers | Force-stop the app, tap the icon, stop when Home's counts show | — |  |  |
| 2 | Cold start **offline** → Home | Airplane mode, force-stop, open: Home must show the saved counts (no Login screen) | instant, no Login |  |  |
| 3 | Home first paint when returning | From the route screen, tap Home | < 300 ms |  |  |
| 4 | Open the 200-stop route | Home → route card → map with pins and list | < 800 ms on 4G |  |  |
| 5 | Scroll the 200-stop list | Fling from top to bottom and back | no visible stutter (bars under the line) |  |  |
| 6 | Pan / zoom the map | Drag and pinch for 5 s on the route map | smooth, ≥ 50 fps |  |  |
| 7 | Tap a stop in the list | Row expands and the map moves to it | < 100 ms to expand |  |  |
| 8 | Deliver a stop | Stop screen → Delivered → back on the route with the stop ticked | 1 request, < 1 s total |  |  |
| 9 | Back to the route after delivering | Time from back tap to the route shown | instant (no spinner) |  |  |
| 10 | Add a typed stop | Type an address, pick a suggestion, Add | suggestions after ≥ 4 chars and 0.5 s pause |  |  |
| 11 | Proof photo upload | Take a photo → until it shows on the stop | note the upload size in the API log |  |  |
| 12 | Start route (200 stops) | Tap Start route as soon as the map shows | never disabled; no pin animation above 30 stops |  |  |
| 13 | Battery over a 1 h route session | Battery % before/after with the route map and navigation in use | note it |  |  |

## Phase 5 — Google calls per stop (before → after)

Sources (fetched 2026-10-24):
- Prices / free tiers: https://developers.google.com/maps/billing-and-pricing/pricing
- Session billing: https://developers.google.com/maps/documentation/places/web-service/session-pricing
- Autocomplete (New): https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
- Place Details (New) and its field → SKU tiers: https://developers.google.com/maps/documentation/places/web-service/place-details
- Session tokens (UUID v4 recommended, one per session, not reusable): https://developers.google.com/maps/documentation/places/web-service/place-session-tokens
- Caching (place IDs may be stored indefinitely; other content only as the terms allow): https://developers.google.com/maps/documentation/places/web-service/policies
- Service Specific Terms (the exact coordinate-caching limit): https://cloud.google.com/maps-platform/terms/maps-service-terms. The page could not be read in full, so the limit is unverified (ISSUE-26).

Prices used (per 1,000, first paid tier):

| SKU | Price | Free / month |
|---|---|---|
| Geocoding | $5.00 | 10,000 |
| Places Text Search Pro | $32.00 | 5,000 |
| Autocomplete Requests | $2.83 | 10,000 |
| Autocomplete Session Usage | free | unlimited |
| Place Details Essentials | $5.00 | 10,000 |

Billing rule used for a session that ends with Place Details Essentials: the first 12 Autocomplete requests are billed as
Autocomplete Requests, the rest are free, and the Details call is billed as Essentials (session-pricing page). Place
Details asks only for `id,location,formattedAddress,addressComponents`, which are Essentials fields; `displayName` would
make it Pro.

Typing assumption: a rider types an address of about 20 characters and pauses about 5 times. Before: searches from 3
characters with a 350 ms pause. After: 4 characters with a 500 ms pause (P3.8), so about 4 searches.

| Stop added by | Before (per stop) | After (per stop) | Cost before → after (paid tier) |
|---|---|---|---|
| **Typed, picking a suggestion** | ~5 searches × (1 Geocoding + 1 Text Search Pro) = **~10 calls** | ~4 Autocomplete + **1** Place Details Essentials (0 if that place was picked in the last 30 days) = **~5 calls**, Geocoding/Text Search **0** | ≈ $0.185 → **≈ $0.016** (~11× less) |
| **Scanned / typed Eircode only** | 1 Geocoding + 1 reverse Geocoding = **2** (then cached 180 days) | **1** Geocoding (then cached 30 days) | $0.010 → **$0.005** |
| **Imported (address text, no point)**, planned into a route | 1 Geocoding, +1 Text Search Pro when no exact match; a "not found" was looked up again at every build, optimise and retry | 1 Geocoding (+1 Text Search Pro when no exact match); "not found" cached 1 day (P1.13) | $0.005–$0.037 per build → the same once, then **$0 for repeats** that day |
| Dropped pin (reverse) | 1 Geocoding | 1 Geocoding | unchanged |
| Town search (service area) | ~3 × (1 Geocoding + 1 Text Search Pro) | ~3 Autocomplete + 1 Details on pick | ≈ $0.111 → ≈ $0.013 |

Other changes:
- **Per-rider daily caps (P5.5):** 600 lookups (check, pin, picked suggestion) and 4,000 searches. A stuck app loop or a misused account can cost at most ≈ $0.011 × 4,000 + $0.005 × 600 ≈ **$14/day**, instead of being unbounded.
- **Metrics (P5.6):** every call is counted per day, rider and API in `google_usage`, at `GET /api/v1/admin/google-usage?from=&to=[&riderId=]`. Use this to replace the assumptions above with real numbers after a week of use.
- **Cache policy (P5.4):** coordinates and addresses cached at most 30 days (found), 7 days (approximate) and 1 day (not found). Place IDs are only used inside a session, and Details results are cached by place ID for 30 days.

## Phase 6a — Routing POC (OSRM + VROOM): benchmark and server size

**Status: not measured yet (ISSUE-31).** The downloads were too slow in the environment where this was prepared. The
setup and benchmark are ready: run them with the commands in `infra/routing/README.md`, then replace the estimates below
with the numbers from `infra/routing/bench/results/*.json`.

Results to fill in (one row per size, from the benchmark):

| Stops | VROOM solve (s) | VROOM road km | Current planner road km (as in production) | Δ km | Current planner fed OSRM (km / s) | OSRM table (s) | Peak RAM osrm / vroom (MiB) |
|---|---|---|---|---|---|---|---|
| 200 |  |  |  |  |  |  |  |
| 1,000 |  |  |  |  |  |  |  |
| 2,000 |  |  |  |  |  |  |  |

Already known without the map:
- **Current planner, 200 synthetic Dublin stops:** about 1.8–1.9 s of Python CPU per optimisation on this laptop (offline self-test). Above 60 points it plans on straight lines (×1.3), so its km can only be checked against OSRM.
- **Phase 1:** about 9–10 s for 1,000 stops (perf.md "Phase 1").

### Server size (provisional estimate, to confirm with the benchmark)

| Role | Size | Why |
|---|---|---|
| Building the map (`prepare-ireland.sh`, daily or weekly) | 2 vCPU, **8 GB RAM**, 10 GB disk, minutes per run; can be a CI job or the same box with swap | osrm-extract of a ~0.4 GB extract typically needs several GB of RAM; serving needs much less |
| Serving OSRM + VROOM (Ireland, bicycle) | **2 vCPU / 4 GB RAM** to start (e.g. Hetzner CPX21 / DigitalOcean 2 vCPU-4 GB), 10 GB disk | osrm-routed (MLD) keeps the Ireland data set in memory (expected 1–2 GB). VROOM's memory is small (a 2,001² matrix is ~32 MB per annotation); it is CPU-bound |
| Scaling | add vCPUs (VROOM `threads` in vroom-conf/config.yml) or a second VROOM container; OSRM is shared | one 2,000-stop optimisation keeps one vCPU busy for tens of seconds (estimate); queue optimisations (P7.3) instead of running many at once |

These are estimates from the data size and the tools' design, not measurements. The benchmark's peak memory and solve
times replace them.

## Phase 6b — Optimising a 200-stop route (async job)

Measured locally (laptop, local Postgres, in-process API + worker). VROOM/OSRM were not available here (ISSUE-31), so
this is the **fallback path**: the built-in planner in the worker, on straight-line distances.

| Step | Time |
|---|---|
| `POST /api/v2/routes/{id}/optimize` answers (job queued) | **21 ms** (the API does no planning) |
| Job done (worker: built-in planner, 200 stops) | **2.5 s** after the request (poll `GET /api/v2/jobs/{id}`) |
| `POST /api/v1/routes/build`, 200 stops (v1 waits for the worker's plan) | 2.8 s |

With VROOM + our OSRM configured (`VROOM_URL`, `OSRM_URL`), the order comes from VROOM on road times. Its solve time is
the "VROOM solve" column of the Phase 6a table, still to be measured (ISSUE-31).

## Phase 8 — Load testing (k6 / Locust)

**Status: the suite is written, nothing has been measured.** There is no staging
environment to load (ISSUE-35): `render.yaml` defines one service (`routify-api`,
the production one), the app points at a laptop on the LAN, and no config file
names a staging host. The scripts refuse to run against anything that is not
clearly a staging host, so nothing was sent anywhere — no request reached
production.

### What is in the suite (`infra/loadtest/`)

| File | What it does |
|---|---|
| `k6/scenarios/route200.js` | a rider with a prepared 200-stop route: open Home, open the route, deliver the next stop |
| `k6/scenarios/dropout.js` | the phone sends the event and the answer is lost (10 ms timeout); it retries later with the same `Idempotency-Key` |
| `k6/scenarios/duplicates.js` | the same batch (same `clientId`s) and the same event sent twice |
| `k6/scenarios/two-devices.js` | two VUs share one account and deliver the same stop at the same time |
| `k6/scenarios/optimize.js` | half the VUs optimise the 200-stop route, half only read — the API must stay fast |
| `k6/scenarios/ramp.js` | P8.2: 1K → 5K → 10K concurrent riders |
| `locust/locustfile.py` | the same scenarios in Locust |
| `scripts/seed_riders.py` | creates the riders, activates a plan, adds 200 stops, builds the route, writes the rider file |
| `scripts/measure_route_open.py` | the size of an opened route on the wire (gzipped) |
| `scripts/report_targets.py` | reads the k6 summaries and prints the table below |
| `scripts/run.sh` | the staging-only runner (`seed`, `route200`, `dropout`, `duplicates`, `two-devices`, `optimize`, `ramp`, `size`, `report`, `check`) |

The guard was tested: no URL, a production URL, a URL without "staging" in it and
`localhost` are all refused before any request is sent. The scripts themselves were
not executed: k6 and Locust are not installed in this environment, and there is no
staging target to run them against.

### Results (target vs measured)

Nothing was measured on staging. The run needs a staging API in
`LOADTEST_BASE_URL`; the commands are in `infra/loadtest/README.md`.

| Target | Limit | Measured | Status |
|---|---|---|---|
| P8.2 ramp 1K → 5K → 10K riders | — | not measured (no staging) | ⚠️ ISSUE-35 |
| P8.3 simple read p95 | < 150 ms | not measured (no staging) | ⚠️ ISSUE-35 |
| P8.4 stop event p95 | < 250 ms | not measured (no staging) | ⚠️ ISSUE-35 |
| P8.5 route open (200 stops) | < 800 ms on 4G | not measured (no staging, no 4G phone) | ⚠️ ISSUE-35 |
| P8.5 route open (200 stops), gzipped | < 150 KB | not measured on staging; 5.2 KB gzipped locally (Phase 1, 200 stops) | ⚠️ ISSUE-35 |
| P8.6 optimise 200 stops | < 5 s | not measured on staging; 2.5 s locally with the fallback planner (Phase 6b), VROOM path still unmeasured (ISSUE-31) | ⚠️ ISSUE-35 |
| P8.6 the API is not blocked during an optimisation | — | not measured on staging | ⚠️ ISSUE-35 |
| P8.7 Home = 1 request, deliver = 1 request | 1 / 1 | 1 / 1 by design (Phase 3), not measured under load | ⚠️ ISSUE-35 |
| P8.7 Home first paint | < 300 ms | not measured (needs a real phone) | ⚠️ ISSUE-35 |
| P8.8 zero duplicates, zero lost events | 0 / 0 | not measured under load; covered by the Phase 4 tests only | ⚠️ ISSUE-35 |
| P8.8 error rate | < 0.1 % | not measured (no staging) | ⚠️ ISSUE-35 |

### What the staging environment needs before the run

- Its own service and database (P7.5): a second Render service on a separate Neon
  branch, with separate keys and the worker process running (`python -m app.worker`,
  ISSUE-32) — route optimisation runs in the worker, not in the API.
- Riders must be able to create stops: a plan per rider (`pro`, not the trial plan:
  the trial plan allows 100 deliveries a month and a 200-stop route needs more).
  The staging mock store does that (`PAYMENT_STORES=mock`, `ALLOW_MOCK_STORE=true`),
  or an `owner_admin` account can (`--activate admin`).
- Raised rate limits: the API counts 1,000 requests per IP per 15 minutes and 40
  registrations per IP per 15 minutes. A 10K-rider run is far above that, so the
  staging environment must raise the limits, disable them (`NODE_ENV=test`) or the
  run must come from several IPs.
- A k6 machine that can hold the VUs: about 4 GB of memory per 1,000 VUs, so the
  10K-rider stage needs roughly 40 GB. The ramp can be split across several
  machines with `RIDER_FILE` per machine, but then the p95 of the whole fleet is not
  one number — a single big machine (or several k6 instances behind one report) is
  needed for a clean P8.2 result.
