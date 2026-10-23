"""`python -m app` starts the API on PORT (auto-reload in development).

WEB_CONCURRENCY > 1 starts that many API processes (needs REDIS_URL so rate limits and caches are shared, P7.2). On
SIGTERM each stops taking requests and lets running ones finish for up to GRACEFUL_SHUTDOWN_SECONDS (P7.4)."""
import uvicorn

from .config import env

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=env.PORT,
        reload=env.NODE_ENV == "development",
        reload_dirs=["app"] if env.NODE_ENV == "development" else None,
        workers=None if env.NODE_ENV == "development" else env.WEB_CONCURRENCY,
        timeout_graceful_shutdown=env.GRACEFUL_SHUTDOWN_SECONDS,
        # Client IPs come from TRUST_PROXY (like Express "trust proxy"), so uvicorn must not rewrite them itself.
        proxy_headers=False,
        server_header=False,
        log_level="warning",
    )
