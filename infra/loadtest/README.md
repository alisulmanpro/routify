# Load testing (Phase 8)

k6 and Locust scenarios for the targets in `task.md` P8.1–P8.8.

**Staging only.** The scripts refuse to run against anything that is not clearly a
staging host, and they always refuse the known production hosts (`PROD_HOSTS`). A
production URL cannot be loaded by accident. A local rehearsal is possible with
`ALLOW_LOCAL=1`, but its numbers are **not** staging numbers and must not be used to
tick a target.

## Files

| Path | What |
|---|---|
| `k6/lib/staging.js` | the staging guard (used by every scenario's `setup()`) |
| `k6/lib/api.js` | API client: batch stops, build/start route, stop events, open route, optimise job |
| `k6/lib/riders.js` | rider file (accounts + tokens), token refresh on 401 |
| `k6/lib/targets.js` | the P8.3–P8.8 targets as k6 thresholds |
| `k6/scenarios/route200.js` | P8.1: a rider with a prepared 200-stop route |
| `k6/scenarios/dropout.js` | P8.1: network drops — the event is sent, the answer is lost, the phone retries |
| `k6/scenarios/duplicates.js` | P8.1: the same batch and the same event sent twice |
| `k6/scenarios/two-devices.js` | P8.1: two devices on one account deliver the same stop |
| `k6/scenarios/optimize.js` | P8.6: optimise 200 stops while the API keeps serving |
| `k6/scenarios/ramp.js` | P8.2: ramp 1K → 5K → 10K concurrent riders |
| `locust/locustfile.py` | the same scenarios in Locust |
| `scripts/seed_riders.py` | creates the riders and their 200-stop routes, writes the rider file |
| `scripts/run.sh` | the staging-only runner (`seed`, `route200`, `dropout`, `duplicates`, `two-devices`, `optimize`, `ramp`, `all`, `report`, `check`) |
| `scripts/report_targets.py` | reads the k6 summaries and prints target vs measured |
| `scripts/measure_route_open.py` | P8.5: the size of an opened route on the wire (gzipped) |

## What to install

```bash
# k6 (one binary): install it the way your machine prefers
#   docker run --rm -i grafana/k6 run - <script.js>
#   or the k6 release binary from the k6 project (package name: k6)

# Locust (optional, the same scenarios)
pipx install locust
```

## Before the run (staging must be ready)

1. **A staging environment.** There is none yet: `render.yaml` defines one service
   (`routify-api`, the production one) and P7.5 (dev/staging/prod) is still open.
   Create a separate Render service and a separate Neon branch/database for staging.
2. **Rate limits.** The API counts 1,000 requests per IP per 15 minutes and
   registration is 40 per IP per 15 minutes. A 10K-rider run is far above that, so
   the staging environment must either raise the limits, disable them
   (`NODE_ENV=test` disables the limiters) or run the load from several IPs.
3. **A plan for every rider.** Creating stops needs an active plan. The trial plan
   allows 100 deliveries a month, so a 200-stop rider needs `pro`. The staging
   environment must have the mock store on (`PAYMENT_STORES=mock`,
   `ALLOW_MOCK_STORE=true`) or an `owner_admin` account to set the plan
   (`--activate admin`).
4. **The worker running.** Route optimisation runs in the worker process
   (`python -m app.worker`), not in the API. Without it the optimise job never
   finishes (ISSUE-32).

## Run

```bash
cd infra/loadtest
cp .env.example .env            # set LOADTEST_BASE_URL to the staging API
mkdir -p data results

# 1. create the riders and their 200-stop routes (writes data/riders.json)
./scripts/run.sh seed --riders 100 --stops 200

# 2. a quick check that everything is in place (sends nothing)
./scripts/run.sh check

# 3. the scenarios
./scripts/run.sh route200
./scripts/run.sh dropout
./scripts/run.sh duplicates
./scripts/run.sh two-devices
./scripts/run.sh optimize

# 4. the ramp (P8.2). 10K VUs need a big k6 machine: about 4 GB per 1,000 VUs.
#    The ramp riders only read, so they need no route: seed them with --stops 0.
./infra/loadtest/scripts/seed_riders.py --base-url "$LOADTEST_BASE_URL" \
  --riders 10000 --stops 0 --out infra/loadtest/data/riders-readonly.json
./scripts/run.sh ramp

# 4b. how big an opened route is on the wire (P8.5)
./scripts/run.sh size

# 5. the table: target vs measured
./scripts/run.sh report
```

Every run writes `results/<scenario>-<time>.json` (the k6 summary). `report` reads
those files and prints the P8.3–P8.8 table; `--markdown out.md` writes it for
`perf.md`.

With Locust instead of k6:

```bash
export LOADTEST_BASE_URL=https://routify-api-staging.onrender.com
export LOCUST_SCENARIO=route200      # route200 | dropout | duplicates | two_devices
locust -f infra/loadtest/locust/locustfile.py --host "$LOADTEST_BASE_URL" \
       --users 100 --spawn-rate 20 --run-time 5m --csv infra/loadtest/results/locust
```

## What each scenario proves

| Scenario | What it must show |
|---|---|
| `route200` | opening Home and a 200-stop route and delivering a stop stay inside the p95 targets; the body on the wire stays under 150 KB gzipped |
| `dropout` | an event whose answer was lost is retried with the same `Idempotency-Key` and is applied **once**: no lost event, no double delivery |
| `duplicates` | the same batch (same `clientId`s) sent twice creates 0 new stops; the same event key twice changes nothing |
| `two-devices` | two devices on one account delivering the same stop: the stop is delivered once, one device gets the "already done" answer, no conflict |
| `optimize` | a 200-stop optimisation finishes in under 5 s and the reads keep their p95 while it runs (the API is not blocked) |
| `ramp` | 1K → 5K → 10K concurrent riders: read p95 < 150 ms, stop event p95 < 250 ms, error rate < 0.1 % |

## Targets (task.md P8.3–P8.8)

| Target | What | Limit |
|---|---|---|
| P8.3 | simple read p95 | < 150 ms |
| P8.4 | stop event p95 | < 250 ms |
| P8.5 | route open (200 stops) | < 800 ms on 4G, < 150 KB gzipped |
| P8.6 | optimise 200 stops | < 5 s, never blocks the API |
| P8.7 | Home = 1 request, deliver = 1 request, Home first paint | 1 / 1 / < 300 ms |
| P8.8 | duplicates, lost events, error rate | 0 / 0 / < 0.1 % |

P8.5's "on 4G" and P8.7's "first paint" are phone measurements: they need a real
device on a 4G connection (the table in `perf.md` "Timings to measure on a real
phone"), not a load test.

## Results

None yet: there is no staging environment to load (see `issue.md`, ISSUE-35). The
numbers go into `perf.md` under "Phase 8".
