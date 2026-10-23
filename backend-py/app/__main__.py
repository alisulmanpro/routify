"""`python -m app` starts the API on uvicorn, on PORT (auto-reload in development). `./start.sh` wraps it.

    python -m app                       # development: http://localhost:4000, reloads on code changes
    python -m app --port 5000 --no-reload
    python -m app --workers 4           # production style: 4 API processes, no reload

Every option defaults to the environment (.env), so `python -m app` alone behaves as before.
WEB_CONCURRENCY > 1 starts that many API processes (needs REDIS_URL so rate limits and caches are shared, P7.2). On
SIGTERM each stops taking requests and lets running ones finish for up to GRACEFUL_SHUTDOWN_SECONDS (P7.4)."""
from __future__ import annotations

import argparse
import logging

import uvicorn

from .config import env
from .logger import _LEVELS, log, uvicorn_log_config


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    development = env.NODE_ENV == "development"
    parser = argparse.ArgumentParser(prog="python -m app", description="Start the Routify API on uvicorn.")
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on (default: %(default)s)")
    parser.add_argument("--port", type=int, default=env.PORT, help="port to listen on (default: PORT, %(default)s)")
    parser.add_argument("--reload", action=argparse.BooleanOptionalAction, default=development,
                        help="restart on code changes (default: on in development)")
    parser.add_argument("--workers", type=int, default=None if development else env.WEB_CONCURRENCY,
                        help="API processes, ignored with --reload (default: WEB_CONCURRENCY outside development)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    workers = None if args.reload else args.workers
    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    log(logging.INFO, f"Starting Routify API on http://{shown}:{args.port}", env=env.NODE_ENV, reload=args.reload, workers=workers or 1,
        docs=None if env.is_production else f"http://{shown}:{args.port}/docs", logs=f"{env.LOG_FORMAT}/{env.LOG_LEVEL}")
    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=["app"] if args.reload else None,
        workers=workers,
        timeout_graceful_shutdown=env.GRACEFUL_SHUTDOWN_SECONDS,
        # Client IPs come from TRUST_PROXY (like Express "trust proxy"), so uvicorn must not rewrite them itself.
        proxy_headers=False,
        server_header=False,
        log_config=uvicorn_log_config(),
        log_level=_LEVELS.get(env.LOG_LEVEL, logging.INFO),
        access_log=False,  # EdgeMiddleware logs every request with its status, time and database queries
    )


if __name__ == "__main__":
    main()
