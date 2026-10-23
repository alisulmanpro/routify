#!/usr/bin/env sh
# Starts the Routify API on uvicorn (see app/__main__.py). Uses .venv when there is one.
#
#   ./start.sh                     API only (development: http://localhost:4000, reloads on code changes)
#   ./start.sh --worker            API + background-job worker in one terminal (Ctrl+C stops both)
#   ./start.sh --port 5000 --no-reload
#   ./start.sh --help              every option
set -eu
cd "$(dirname "$0")"
[ -x .venv/bin/python ] && PY=.venv/bin/python || PY=python3

if [ "${1:-}" = "--worker" ]; then
  shift
  "$PY" -m app.worker &
  WORKER=$!
  trap 'kill "$WORKER" 2>/dev/null || true; wait "$WORKER" 2>/dev/null || true' EXIT INT TERM
  "$PY" -m app "$@"
else
  exec "$PY" -m app "$@"
fi
