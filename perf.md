# perf.md — Performance measurements

## How these numbers were measured

- **Tool:** `backend-py/scripts/perf_routes.py`. It drives the real FastAPI app in-process, with every middleware included, and counts each round trip to the Prisma query engine: queries, batches and transaction begin/commit. It also counts the SQL statements inside batches, the wall time per flow and the response size.
- **Not the timing middleware:** P0.7 (timing middleware with a `Server-Timing` header) has not been built yet; Phase 0 was blocked on the dev database (see ISSUE-06). The harness counts the same things from outside the app.
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
