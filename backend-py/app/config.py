"""Environment configuration, validated once at import time (mirrors the old zod schema)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class ConfigError(RuntimeError):
    pass


# console: prints emails to the log (development only) · disabled: drops them · the rest send for real.
EMAIL_PROVIDERS = ("console", "disabled", "smtp", "brevo", "sendgrid", "resend", "mailgun", "postmark")
_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


_problems: list[str] = []


_VERSION_RE = re.compile(r"^\d{1,4}(\.\d{1,4}){0,2}$")


def _version(name: str, default: str) -> str:
    value = _str(name, default) or default
    if not _VERSION_RE.fullmatch(value):
        _problems.append(f"  - {name}: expected a version such as 1.4.0")
    return value


def _str(name: str, default: str | None = None, *, required: bool = False, min_len: int = 0) -> str | None:
    value = os.environ.get(name)
    if value is None or value == "":
        if required:
            _problems.append(f"  - {name}: {name} is required")
        return default
    if len(value) < min_len:
        _problems.append(f"  - {name}: {name} must be at least {min_len} characters")
    return value


def _int(name: str, default: int, *, lo: int | None = None, hi: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(float(raw))
        if float(raw) != value:
            raise ValueError
    except ValueError:
        _problems.append(f"  - {name}: expected an integer")
        return default
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        _problems.append(f"  - {name}: must be between {lo} and {hi}")
    return value


def _enum(name: str, choices: tuple[str, ...], default: str) -> str:
    value = os.environ.get(name) or default
    if value not in choices:
        _problems.append(f"  - {name}: must be one of {', '.join(choices)}")
        return default
    return value


def _bool(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return None
    if raw not in ("true", "false"):
        _problems.append(f"  - {name}: must be true or false")
        return None
    return raw == "true"


@dataclass(frozen=True)
class Settings:
    NODE_ENV: str
    PORT: int
    LOG_LEVEL: str
    DATABASE_URL: str
    JWT_ACCESS_SECRET: str
    JWT_REFRESH_SECRET: str
    FILE_SIGNING_SECRET: str
    ACCESS_TOKEN_TTL_SECONDS: int
    REFRESH_TOKEN_TTL_DAYS: int
    BCRYPT_ROUNDS: int
    cors_origins: tuple[str, ...]
    TRUST_PROXY: int
    cookie_secure: bool
    COOKIE_SAMESITE: str
    STORAGE_DIR: str
    SIGNED_URL_TTL_SECONDS: int
    GEOCODING_PROVIDER: str
    GEOCODING_USER_AGENT: str | None
    GOOGLE_MAPS_API_KEY: str | None
    ROUTING_PROVIDER: str
    ROUTING_TRAVEL_MODE: str
    OSRM_URL: str
    OSRM_PROFILE: str
    VROOM_URL: str
    VROOM_PROFILE: str
    PLANNER_INLINE_MAX: int
    PLAN_JOB_WAIT_SECONDS: int
    STORAGE_BACKEND: str
    S3_ENDPOINT: str
    S3_BUCKET: str
    S3_REGION: str
    S3_ACCESS_KEY_ID: str
    S3_SECRET_ACCESS_KEY: str
    REDIS_URL: str
    REDIS_KEY_PREFIX: str
    WEB_CONCURRENCY: int
    GRACEFUL_SHUTDOWN_SECONDS: int
    WORKER_CONCURRENCY: int
    LOG_SHIP_URL: str
    LOG_SHIP_TOKEN: str
    ALERT_WEBHOOK_URL: str
    ALERT_ERROR_RATE: float
    ALERT_P95_MS: int
    ALERT_QUEUE_BACKLOG: int
    ALERT_GOOGLE_DAILY_USD: float
    SENTRY_DSN: str
    SENTRY_TRACES_SAMPLE_RATE: float
    ADMIN_EMAIL: str | None
    ADMIN_PASSWORD: str | None
    ADMIN_NAME: str
    EMAIL_PROVIDER: str
    EMAIL_FROM: str | None
    EMAIL_FROM_NAME: str
    EMAIL_REPLY_TO: str | None
    EMAIL_API_KEY: str | None
    EMAIL_API_REGION: str
    MAILGUN_DOMAIN: str | None
    SMTP_HOST: str | None
    SMTP_PORT: int
    SMTP_USERNAME: str | None
    SMTP_PASSWORD: str | None
    SMTP_SECURITY: str
    PASSWORD_RESET_TTL_MINUTES: int
    payment_stores: tuple[str, ...]
    ALLOW_MOCK_STORE: bool
    APPLE_BUNDLE_ID: str | None
    APPLE_APP_ID: int | None
    APPLE_ENVIRONMENT: str
    GOOGLE_PACKAGE_NAME: str | None
    GOOGLE_SERVICE_ACCOUNT_FILE: str | None
    GOOGLE_PUBSUB_AUDIENCE: str | None
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: str | None
    MIN_APP_VERSION: str
    LATEST_APP_VERSION: str
    REVENUECAT_SECRET_API_KEY: str | None
    REVENUECAT_WEBHOOK_AUTH: str | None
    REVENUECAT_ENTITLEMENT: str

    @property
    def is_production(self) -> bool:
        return self.NODE_ENV == "production"

    @property
    def is_test(self) -> bool:
        return self.NODE_ENV == "test"


def load_settings() -> Settings:
    _problems.clear()
    node_env = _enum("NODE_ENV", ("development", "test", "production"), os.environ.get("APP_ENV") or "development")
    is_production = node_env == "production"

    admin_email = _str("ADMIN_EMAIL")
    if admin_email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", admin_email):
        _problems.append("  - ADMIN_EMAIL: Invalid email")
    admin_password = _str("ADMIN_PASSWORD")
    if admin_password is not None and len(admin_password) < 10:
        _problems.append("  - ADMIN_PASSWORD: must be at least 10 characters")

    cookie_secure = _bool("COOKIE_SECURE")
    email_from = _str("EMAIL_FROM")
    if email_from and not _EMAIL_RE.fullmatch(email_from):
        _problems.append("  - EMAIL_FROM: Invalid email")
    reply_to = _str("EMAIL_REPLY_TO")
    if reply_to and not _EMAIL_RE.fullmatch(reply_to):
        _problems.append("  - EMAIL_REPLY_TO: Invalid email")
    settings = Settings(
        NODE_ENV=node_env,
        PORT=_int("PORT", 4000, lo=1),
        LOG_LEVEL=_str("LOG_LEVEL", "info") or "info",
        DATABASE_URL=_str("DATABASE_URL", required=True) or "",
        JWT_ACCESS_SECRET=_str("JWT_ACCESS_SECRET", required=True, min_len=32) or "",
        JWT_REFRESH_SECRET=_str("JWT_REFRESH_SECRET", required=True, min_len=32) or "",
        FILE_SIGNING_SECRET=_str("FILE_SIGNING_SECRET", required=True, min_len=32) or "",
        ACCESS_TOKEN_TTL_SECONDS=_int("ACCESS_TOKEN_TTL_SECONDS", 900, lo=1),
        REFRESH_TOKEN_TTL_DAYS=_int("REFRESH_TOKEN_TTL_DAYS", 30, lo=1),
        BCRYPT_ROUNDS=_int("BCRYPT_ROUNDS", 12, lo=4, hi=15),
        cors_origins=tuple(s.strip() for s in (_str("CORS_ORIGINS", "http://localhost:5173") or "").split(",") if s.strip()),
        TRUST_PROXY=_int("TRUST_PROXY", 0, lo=0),
        cookie_secure=is_production if cookie_secure is None else cookie_secure,
        COOKIE_SAMESITE=_enum("COOKIE_SAMESITE", ("strict", "lax", "none"), "strict"),
        STORAGE_DIR=_str("STORAGE_DIR", "./uploads") or "./uploads",
        SIGNED_URL_TTL_SECONDS=_int("SIGNED_URL_TTL_SECONDS", 900, lo=1),
        GEOCODING_PROVIDER=_enum("GEOCODING_PROVIDER", ("nominatim", "google", "none"), "nominatim"),
        GEOCODING_USER_AGENT=_str("GEOCODING_USER_AGENT"),
        GOOGLE_MAPS_API_KEY=_str("GOOGLE_MAPS_API_KEY"),
        # Road data (matrix, geometry, navigation): osrm = our own OSRM (infra/routing, OSRM_URL), never the public demo
        # server; google = Routes API matrix (≤ 60 points); none = straight lines.
        ROUTING_PROVIDER=_enum("ROUTING_PROVIDER", ("google", "osrm", "none"),
                               "osrm" if _str("OSRM_URL") else "google" if _str("GOOGLE_MAPS_API_KEY") else "none"),
        ROUTING_TRAVEL_MODE=_enum("ROUTING_TRAVEL_MODE", ("BICYCLE", "DRIVE", "TWO_WHEELER"), "BICYCLE"),
        OSRM_URL=(_str("OSRM_URL") or "").rstrip("/"),
        # The profile name in OSRM URLs (one OSRM data set answers any name; it is built for OSRM_PROFILE in infra/routing).
        OSRM_PROFILE=_str("OSRM_PROFILE", "bike") or "bike",
        # Route optimisation by our VROOM (infra/routing); empty = the built-in Python planner only.
        VROOM_URL=(_str("VROOM_URL") or "").rstrip("/"),
        VROOM_PROFILE=_str("VROOM_PROFILE", "bike") or "bike",
        # Plans up to this many stops run inside the API (a few ms); larger ones always go to the worker process.
        PLANNER_INLINE_MAX=_int("PLANNER_INLINE_MAX", 8, lo=0, hi=12),
        # How long a v1 build/optimise request waits for the worker before answering 503.
        PLAN_JOB_WAIT_SECONDS=_int("PLAN_JOB_WAIT_SECONDS", 90, lo=5, hi=600),
        # Files (proof photos, report PDFs): local disk (STORAGE_DIR) for development, or an S3-compatible bucket
        # (Cloudflare R2: S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com, S3_REGION=auto). s3 when S3_BUCKET is set.
        STORAGE_BACKEND=_enum("STORAGE_BACKEND", ("local", "s3"), "s3" if _str("S3_BUCKET") else "local"),
        S3_ENDPOINT=(_str("S3_ENDPOINT") or "").rstrip("/"),
        S3_BUCKET=_str("S3_BUCKET") or "",
        S3_REGION=_str("S3_REGION", "auto") or "auto",
        S3_ACCESS_KEY_ID=_str("S3_ACCESS_KEY_ID") or "",
        S3_SECRET_ACCESS_KEY=_str("S3_SECRET_ACCESS_KEY") or "",
        # Shared rate limits, caches and request metrics across API instances; empty = per-process (local development).
        REDIS_URL=_str("REDIS_URL") or "",
        REDIS_KEY_PREFIX=_str("REDIS_KEY_PREFIX", "routify:") or "routify:",
        # Uvicorn worker processes per instance, and how long a stopping instance lets running requests finish.
        WEB_CONCURRENCY=_int("WEB_CONCURRENCY", 1, lo=1, hi=32),
        GRACEFUL_SHUTDOWN_SECONDS=_int("GRACEFUL_SHUTDOWN_SECONDS", 25, lo=1, hi=300),
        # Jobs one worker process runs at a time (emails and PDFs wait on the network; plans use a thread each).
        WORKER_CONCURRENCY=_int("WORKER_CONCURRENCY", 2, lo=1, hi=16),
        # Log shipping: JSON lines POSTed in batches (e.g. Better Stack / Logtail HTTP source). Empty = stdout only.
        LOG_SHIP_URL=_str("LOG_SHIP_URL") or "",
        LOG_SHIP_TOKEN=_str("LOG_SHIP_TOKEN") or "",
        # Alerts (Slack-compatible incoming webhook) and their thresholds; checked every 5 minutes by the worker.
        ALERT_WEBHOOK_URL=_str("ALERT_WEBHOOK_URL") or "",
        ALERT_ERROR_RATE=float(_str("ALERT_ERROR_RATE", "0.02") or 0.02),
        ALERT_P95_MS=_int("ALERT_P95_MS", 1000, lo=50, hi=60_000),
        ALERT_QUEUE_BACKLOG=_int("ALERT_QUEUE_BACKLOG", 10, lo=1, hi=100_000),
        ALERT_GOOGLE_DAILY_USD=float(_str("ALERT_GOOGLE_DAILY_USD", "20") or 20),
        # Error reporting (P0.8). Empty = off. Traces: the share of requests sampled for performance (0 = errors only).
        SENTRY_DSN=_str("SENTRY_DSN") or "",
        SENTRY_TRACES_SAMPLE_RATE=min(1.0, max(0.0, float(_str("SENTRY_TRACES_SAMPLE_RATE", "0.05") or 0))),
        ADMIN_EMAIL=admin_email,
        ADMIN_PASSWORD=admin_password,
        ADMIN_NAME=_str("ADMIN_NAME", "Platform Admin") or "Platform Admin",
        # Production never falls back to "console": it would write reset codes into the logs.
        EMAIL_PROVIDER=_enum("EMAIL_PROVIDER", EMAIL_PROVIDERS, "disabled" if is_production else "console"),
        EMAIL_FROM=email_from,
        EMAIL_FROM_NAME=_str("EMAIL_FROM_NAME", "Routify") or "Routify",
        EMAIL_REPLY_TO=reply_to,
        EMAIL_API_KEY=_str("EMAIL_API_KEY"),
        EMAIL_API_REGION=_enum("EMAIL_API_REGION", ("us", "eu"), "us"),
        MAILGUN_DOMAIN=_str("MAILGUN_DOMAIN"),
        SMTP_HOST=_str("SMTP_HOST"),
        SMTP_PORT=_int("SMTP_PORT", 587, lo=1, hi=65535),
        SMTP_USERNAME=_str("SMTP_USERNAME"),
        SMTP_PASSWORD=_str("SMTP_PASSWORD"),
        SMTP_SECURITY=_enum("SMTP_SECURITY", ("starttls", "ssl", "none"), "starttls"),
        PASSWORD_RESET_TTL_MINUTES=_int("PASSWORD_RESET_TTL_MINUTES", 15, lo=5, hi=60),
        payment_stores=_stores(is_production),
        ALLOW_MOCK_STORE=_bool("ALLOW_MOCK_STORE") or False,
        APPLE_BUNDLE_ID=_str("APPLE_BUNDLE_ID"),
        APPLE_APP_ID=_int("APPLE_APP_ID", 0, lo=0) or None,
        APPLE_ENVIRONMENT=_enum("APPLE_ENVIRONMENT", ("sandbox", "production"), "sandbox"),
        GOOGLE_PACKAGE_NAME=_str("GOOGLE_PACKAGE_NAME"),
        GOOGLE_SERVICE_ACCOUNT_FILE=_str("GOOGLE_SERVICE_ACCOUNT_FILE"),
        GOOGLE_PUBSUB_AUDIENCE=_str("GOOGLE_PUBSUB_AUDIENCE"),
        GOOGLE_PUBSUB_SERVICE_ACCOUNT=_str("GOOGLE_PUBSUB_SERVICE_ACCOUNT"),
        # The app shows a blocking "Update the app" screen below MIN_APP_VERSION and a gentle prompt below LATEST_APP_VERSION.
        MIN_APP_VERSION=_version("MIN_APP_VERSION", "1.0.0"),
        LATEST_APP_VERSION=_version("LATEST_APP_VERSION", "1.0.0"),
        REVENUECAT_SECRET_API_KEY=_str("REVENUECAT_SECRET_API_KEY"),
        REVENUECAT_WEBHOOK_AUTH=_str("REVENUECAT_WEBHOOK_AUTH", min_len=16),
        REVENUECAT_ENTITLEMENT=_str("REVENUECAT_ENTITLEMENT", "routify_pro") or "routify_pro",
    )

    if _problems:
        raise ConfigError("Invalid environment configuration:\n" + "\n".join(_problems) + "\nSee backend-py/.env.example")
    if settings.GEOCODING_PROVIDER == "nominatim" and not settings.GEOCODING_USER_AGENT and is_production:
        raise ConfigError("GEOCODING_USER_AGENT is required for Nominatim (identify your app + contact email)")
    if settings.GEOCODING_PROVIDER == "google" and not settings.GOOGLE_MAPS_API_KEY:
        raise ConfigError("GOOGLE_MAPS_API_KEY is required when GEOCODING_PROVIDER=google")
    if settings.ROUTING_PROVIDER == "google" and not settings.GOOGLE_MAPS_API_KEY:
        raise ConfigError("GOOGLE_MAPS_API_KEY is required when ROUTING_PROVIDER=google")
    if settings.STORAGE_BACKEND == "s3":
        missing = [n for n in ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") if not getattr(settings, n)]
        if missing:
            raise ConfigError(f"STORAGE_BACKEND=s3 needs {', '.join(missing)}")
    if settings.ROUTING_PROVIDER == "osrm" and not settings.OSRM_URL:
        raise ConfigError("OSRM_URL (our own OSRM, see infra/routing) is required when ROUTING_PROVIDER=osrm")
    if is_production and settings.COOKIE_SAMESITE == "none" and cookie_secure is False:
        raise ConfigError("COOKIE_SAMESITE=none requires COOKIE_SECURE=true")
    _check_email(settings)
    _check_payments(settings)
    return settings


PAYMENT_STORES = ("mock", "apple", "google", "revenuecat")


def _stores(is_production: bool) -> tuple[str, ...]:
    raw = _str("PAYMENT_STORES", "" if is_production else "mock") or ""
    stores = tuple(dict.fromkeys(s.strip().lower() for s in raw.split(",") if s.strip()))
    unknown = [s for s in stores if s not in PAYMENT_STORES]
    if unknown:
        _problems.append(f"  - PAYMENT_STORES: unknown store(s) {', '.join(unknown)}; use {', '.join(PAYMENT_STORES)}")
    return tuple(s for s in stores if s in PAYMENT_STORES)


def _check_payments(settings: Settings) -> None:
    stores = settings.payment_stores
    # A staging/demo server may opt in explicitly: the mock store grants paid plans without any payment.
    if "mock" in stores and settings.is_production and not settings.ALLOW_MOCK_STORE:
        raise ConfigError("PAYMENT_STORES=mock is not allowed in production (it grants paid plans without payment); "
                          "set ALLOW_MOCK_STORE=true only on a test/demo server")
    if "apple" in stores:
        if not settings.APPLE_BUNDLE_ID:
            raise ConfigError("APPLE_BUNDLE_ID is required when PAYMENT_STORES includes apple")
        if settings.APPLE_ENVIRONMENT == "production" and not settings.APPLE_APP_ID:
            raise ConfigError("APPLE_APP_ID is required when APPLE_ENVIRONMENT=production")
    if "google" in stores:
        missing = [n for n in ("GOOGLE_PACKAGE_NAME", "GOOGLE_SERVICE_ACCOUNT_FILE", "GOOGLE_PUBSUB_AUDIENCE", "GOOGLE_PUBSUB_SERVICE_ACCOUNT")
                   if not getattr(settings, n)]
        if missing:
            raise ConfigError(f"{', '.join(missing)} required when PAYMENT_STORES includes google")
    if "revenuecat" in stores:
        if not settings.REVENUECAT_SECRET_API_KEY or not settings.REVENUECAT_WEBHOOK_AUTH:
            raise ConfigError("REVENUECAT_SECRET_API_KEY and REVENUECAT_WEBHOOK_AUTH are required when PAYMENT_STORES includes revenuecat")
        if not settings.REVENUECAT_SECRET_API_KEY.startswith("sk_"):
            raise ConfigError("REVENUECAT_SECRET_API_KEY must be a secret key (sk_...), never the app's public SDK key")


def _check_email(settings: Settings) -> None:
    provider = settings.EMAIL_PROVIDER
    if provider == "console" and settings.is_production:
        raise ConfigError("EMAIL_PROVIDER=console is not allowed in production (it logs password reset codes)")
    if provider in ("console", "disabled"):
        return
    if not settings.EMAIL_FROM:
        raise ConfigError(f"EMAIL_FROM is required when EMAIL_PROVIDER={provider}")
    if provider == "smtp":
        if not settings.SMTP_HOST:
            raise ConfigError("SMTP_HOST is required when EMAIL_PROVIDER=smtp")
        if settings.SMTP_SECURITY == "none" and settings.SMTP_PASSWORD and settings.is_production:
            raise ConfigError("SMTP_SECURITY=none would send SMTP_PASSWORD in clear text; use starttls or ssl")
    elif not settings.EMAIL_API_KEY:
        raise ConfigError(f"EMAIL_API_KEY is required when EMAIL_PROVIDER={provider}")
    if provider == "mailgun" and not settings.MAILGUN_DOMAIN:
        raise ConfigError("MAILGUN_DOMAIN is required when EMAIL_PROVIDER=mailgun")


env = load_settings()
