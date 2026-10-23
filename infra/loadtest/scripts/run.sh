#!/usr/bin/env bash
# Run the load tests. STAGING ONLY.
#
# The script refuses any target that is not clearly a staging host, so a load test
# can never reach production by accident.
#
#   export LOADTEST_BASE_URL=https://routify-api-staging.onrender.com
#   ./infra/loadtest/scripts/run.sh seed --riders 100 --stops 200
#   ./infra/loadtest/scripts/run.sh route200
#   ./infra/loadtest/scripts/run.sh all
#
# Options (environment):
#   LOADTEST_BASE_URL        staging API base URL (required, no default)
#   STAGING_HOST_PATTERN     what a staging hostname must match (default: staging)
#   PROD_HOSTS               comma separated production hostnames to refuse
#   ALLOW_LOCAL=1            allow localhost (a rehearsal; its numbers are NOT staging numbers)
#   RIDER_FILE               rider file (default: infra/loadtest/data/riders.json)
#   VUS, RAMP, STEADY, SLEEP k6 knobs
#   K6                      k6 binary (default: k6)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

ENV_FILE="${LOADTEST_ENV_FILE:-infra/loadtest/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

PROD_HOSTS="${PROD_HOSTS:-routify-api.onrender.com,api.routify.ie,www.routify.ie,routify.ie}"
STAGING_HOST_PATTERN="${STAGING_HOST_PATTERN:-staging}"
RIDER_FILE="${RIDER_FILE:-infra/loadtest/data/riders.json}"
RESULTS_DIR="${RESULTS_DIR:-infra/loadtest/results}"
K6="${K6:-k6}"
PYTHON="${PYTHON:-python3}"

die() { echo "" >&2; echo "ERROR: $*" >&2; echo "" >&2; exit 1; }

# ---------------------------------------------------------------- staging guard
guard() {
  [ -n "${LOADTEST_BASE_URL:-}" ] || die "LOADTEST_BASE_URL is not set. Load tests may only run against a staging environment."
  local host
  host="$(printf '%s' "$LOADTEST_BASE_URL" | sed -E 's#^https?://([^/:]+).*#\1#' | tr '[:upper:]' '[:lower:]')"
  [ -n "$host" ] || die "LOADTEST_BASE_URL is not a valid URL: $LOADTEST_BASE_URL"

  case "$host" in
    localhost|127.0.0.1|::1)
      [ "${ALLOW_LOCAL:-0}" = "1" ] || die "Refusing to load test $host. Set ALLOW_LOCAL=1 for a local rehearsal (not a staging result)."
      ;;
    *)
      local p
      for p in ${PROD_HOSTS//,/ }; do
        [ "$host" = "$p" ] && die "Refusing to load test production host $host. Staging only."
        case "$host" in *".$p") die "Refusing to load test production host $host. Staging only." ;; esac
      done
      printf '%s' "$host" | grep -qiE "$STAGING_HOST_PATTERN" \
        || die "Refusing to load test $host: the hostname does not match the staging pattern '$STAGING_HOST_PATTERN'. Staging only."
      ;;
  esac
  export BASE_URL="$LOADTEST_BASE_URL"
  export RIDER_FILE
}

need_k6() { command -v "$K6" >/dev/null 2>&1 || die "k6 is not installed ($K6). See infra/loadtest/README.md."; }
need_riders() { [ -f "$RIDER_FILE" ] || die "Rider file $RIDER_FILE not found. Run: $0 seed --riders 100 --stops 200"; }

run_scenario() {
  local name="$1"; shift
  need_k6
  need_riders
  mkdir -p "$RESULTS_DIR"
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="$RESULTS_DIR/${name}-${stamp}.json"
  echo "==> k6 scenario $name  (target $LOADTEST_BASE_URL)"
  echo "    summary: $out"
  "$K6" run --summary-export "$out" "$@" "infra/loadtest/k6/scenarios/${name}.js" || {
    echo "k6 reported threshold failures for $name (the summary is still written)." >&2
    return 0
  }
}

cmd_seed() {
  guard
  echo "==> seeding riders on $LOADTEST_BASE_URL"
  "$PYTHON" infra/loadtest/scripts/seed_riders.py --base-url "$LOADTEST_BASE_URL" "$@"
}

cmd_report() {
  "$PYTHON" infra/loadtest/scripts/report_targets.py "$@"
}

cmd_size() {
  # P8.5: the size of an opened route on the wire (gzipped).
  guard
  need_riders
  mkdir -p "$RESULTS_DIR"
  local rider
  rider="$("$PYTHON" - "$RIDER_FILE" <<'PY'
import json, sys
riders = json.load(open(sys.argv[1]))
rider = next((r for r in riders if r.get("routeId")), None)
if not rider:
    raise SystemExit("no rider with a route in the rider file")
print(json.dumps({"email": rider["email"], "password": rider["password"], "routeId": rider["routeId"]}))
PY
)"
  local email password route_id
  email="$("$PYTHON" -c 'import json,sys; print(json.loads(sys.argv[1])["email"])' "$rider")"
  password="$("$PYTHON" -c 'import json,sys; print(json.loads(sys.argv[1])["password"])' "$rider")"
  route_id="$("$PYTHON" -c 'import json,sys; print(json.loads(sys.argv[1])["routeId"])' "$rider")"
  "$PYTHON" infra/loadtest/scripts/measure_route_open.py \
    --base-url "$LOADTEST_BASE_URL" --email "$email" --password "$password" --route-id "$route_id" \
    --json "$RESULTS_DIR/route-size-$(date +%Y%m%d-%H%M%S).json"
}

cmd_all() {
  for s in route200 dropout duplicates two-devices optimize; do
    run_scenario "$s"
  done
  cmd_report "$RESULTS_DIR"
}

case "${1:-}" in
  seed) shift; cmd_seed "$@" ;;
  route200|dropout|duplicates|two-devices|optimize|ramp)
    name="$1"; shift; guard; run_scenario "$name" "$@" ;;
  all) shift; guard; cmd_all "$@" ;;
  size) shift; guard; cmd_size "$@" ;;
  report) shift; cmd_report "$@" ;;
  check)
    # Validates the target and the files without sending a single request.
    guard
    need_riders
    for f in infra/loadtest/k6/scenarios/*.js; do node --check "$f" || die "syntax error in $f"; done
    "$PYTHON" -m py_compile infra/loadtest/scripts/seed_riders.py infra/loadtest/scripts/report_targets.py
    echo "OK: staging target $LOADTEST_BASE_URL, rider file $RIDER_FILE, scripts parse."
    ;;
  *)
    cat <<'USAGE'
usage: run.sh <command>

  seed [options]        create riders and their 200-stop routes, write the rider file
  route200              P8.1 scenario: a rider with a prepared 200-stop route
  dropout               P8.1 scenario: network drops, the event is retried
  duplicates            P8.1 scenario: the same batch and event sent twice
  two-devices           P8.1 scenario: two devices on one account
  optimize              P8.6: optimise 200 stops while the API keeps serving
  ramp                  P8.2: 1K -> 5K -> 10K concurrent riders
  all                   every scenario, then the report
  size                  P8.5: how many KB an opened route costs (gzipped)
  report [dir]          compare the results with the Phase 8 targets
  check                 validate the target and the scripts (sends nothing)
USAGE
    exit 1
    ;;
esac
