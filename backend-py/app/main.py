"""FastAPI application: same routes, envelopes and error codes as the former Express API."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from prisma.errors import UniqueViolationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

from . import timing
from .config import env
from .db import connect, disconnect, is_ready
from .errors import AppError, error_body
from .http import ApiJSONResponse, respond
from .logger import log
from .middleware import ApiRateLimitMiddleware, BodyLimitMiddleware, EdgeMiddleware
from .openapi import install_openapi
from .routers import admin, auth, billing_webhooks, deliveries, rider_side, v2
from .services import maintenance
from .services.subscription_service import ensure_default_plans


async def run_maintenance() -> None:
    """The hourly housekeeping, now run by the worker (services/maintenance.py); kept here for scripts and tests."""
    try:
        await maintenance.run_maintenance()
    except Exception:  # noqa: BLE001
        log(logging.ERROR, "Maintenance job failed", exc_info=True)


def create_app(*, run_jobs: bool = True) -> FastAPI:
    """`run_jobs` is kept for callers; scheduled work (maintenance) runs in the worker since P7.3, never in the API."""
    del run_jobs
    timing.install()  # Server-Timing and per-request DB counts (P0.7)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await connect()
        await ensure_default_plans()
        log(logging.INFO, f"Delivery Planner API listening on :{env.PORT} ({env.NODE_ENV})")
        try:
            yield
        finally:
            await disconnect()

    app = FastAPI(title="Routify API", version="2.0.0", lifespan=lifespan, redirect_slashes=False,
                  docs_url=None if env.is_production else "/docs", redoc_url=None, openapi_url=None if env.is_production else "/openapi.json")

    @app.exception_handler(AppError)
    async def app_error(_request: Request, error: AppError):
        return ApiJSONResponse(error_body(error.code, error.message, error.details), status_code=error.status)

    @app.exception_handler(UniqueViolationError)
    async def duplicate(_request: Request, error: UniqueViolationError):
        fields = ((getattr(error, "data", None) or {}).get("user_facing_error", {}).get("meta", {}) or {}).get("target") or []
        return ApiJSONResponse(error_body("DUPLICATE", "A record with these details already exists", [{"fields": list(fields)}]), status_code=409)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, error: StarletteHTTPException):
        if error.status_code in (404, 405):
            return ApiJSONResponse(error_body("NOT_FOUND", "The requested resource was not found"), status_code=404)
        return ApiJSONResponse(error_body("BAD_REQUEST", str(error.detail)), status_code=error.status_code)

    @app.exception_handler(RequestValidationError)
    async def request_validation(_request: Request, error: RequestValidationError):
        details = [{"path": ".".join(str(p) for p in e.get("loc", ())), "message": e.get("msg")} for e in error.errors()]
        return ApiJSONResponse(error_body("VALIDATION_ERROR", "Validation failed", details), status_code=400)

    @app.get("/health")
    async def health():
        return respond({"status": "ok", "service": "delivery-planner-api"})

    @app.get("/ready")
    async def ready():
        if await is_ready():
            return respond({"status": "ready"})
        return ApiJSONResponse(error_body("DATABASE_UNAVAILABLE", "The database is not connected"), status_code=503)

    api = APIRouter(prefix="/api/v1")
    for router in (auth.router, rider_side.config_router, rider_side.files_router, deliveries.router, rider_side.routes_router,
                   rider_side.rider_router, rider_side.reports_router, rider_side.subscriptions_router, billing_webhooks.router, admin.router):
        api.include_router(router)
    app.include_router(api)
    app.include_router(v2.router, prefix="/api/v2")
    if not env.is_production:
        install_openapi(app)

    # Added inner → outer: rate limit runs inside CORS, so preflights are never counted.
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(ApiRateLimitMiddleware)
    app.add_middleware(
        CORSMiddleware, allow_origins=list(env.cors_origins), allow_credentials=True, allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Request-Id"], expose_headers=["X-Request-Id"], max_age=600,
    )
    # JSON (route lists especially) shrinks several times; photos and PDFs are already compressed, so they are sent as they are.
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6, exclude_content_types=(*DEFAULT_EXCLUDED_CONTENT_TYPES, "application/pdf"))
    app.add_middleware(EdgeMiddleware)
    return app


app = create_app()
