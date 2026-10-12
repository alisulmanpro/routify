"""`python -m app` starts the API on PORT (auto-reload in development)."""
import uvicorn

from .config import env

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=env.PORT,
        reload=env.NODE_ENV == "development",
        reload_dirs=["app"] if env.NODE_ENV == "development" else None,
        # Client IPs come from TRUST_PROXY (like Express "trust proxy"), so uvicorn must not rewrite them itself.
        proxy_headers=False,
        server_header=False,
        log_level="warning",
    )
