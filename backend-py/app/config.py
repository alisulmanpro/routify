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
    APPLE_BUNDLE_ID: str | None
    APPLE_APP_ID: int | None
    APPLE_ENVIRONMENT: str
    GOOGLE_PACKAGE_NAME: str | None
    GOOGLE_SERVICE_ACCOUNT_FILE: str | None
    GOOGLE_PUBSUB_AUDIENCE: str | None
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: str | None

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
        APPLE_BUNDLE_ID=_str("APPLE_BUNDLE_ID"),
        APPLE_APP_ID=_int("APPLE_APP_ID", 0, lo=0) or None,
        APPLE_ENVIRONMENT=_enum("APPLE_ENVIRONMENT", ("sandbox", "production"), "sandbox"),
        GOOGLE_PACKAGE_NAME=_str("GOOGLE_PACKAGE_NAME"),
        GOOGLE_SERVICE_ACCOUNT_FILE=_str("GOOGLE_SERVICE_ACCOUNT_FILE"),
        GOOGLE_PUBSUB_AUDIENCE=_str("GOOGLE_PUBSUB_AUDIENCE"),
        GOOGLE_PUBSUB_SERVICE_ACCOUNT=_str("GOOGLE_PUBSUB_SERVICE_ACCOUNT"),
    )

    if _problems:
        raise ConfigError("Invalid environment configuration:\n" + "\n".join(_problems) + "\nSee backend-py/.env.example")
    if settings.GEOCODING_PROVIDER == "nominatim" and not settings.GEOCODING_USER_AGENT and is_production:
        raise ConfigError("GEOCODING_USER_AGENT is required for Nominatim (identify your app + contact email)")
    if settings.GEOCODING_PROVIDER == "google" and not settings.GOOGLE_MAPS_API_KEY:
        raise ConfigError("GOOGLE_MAPS_API_KEY is required when GEOCODING_PROVIDER=google")
    if is_production and settings.COOKIE_SAMESITE == "none" and cookie_secure is False:
        raise ConfigError("COOKIE_SAMESITE=none requires COOKIE_SECURE=true")
    _check_email(settings)
    _check_payments(settings)
    return settings


PAYMENT_STORES = ("mock", "apple", "google")


def _stores(is_production: bool) -> tuple[str, ...]:
    raw = _str("PAYMENT_STORES", "" if is_production else "mock") or ""
    stores = tuple(dict.fromkeys(s.strip().lower() for s in raw.split(",") if s.strip()))
    unknown = [s for s in stores if s not in PAYMENT_STORES]
    if unknown:
        _problems.append(f"  - PAYMENT_STORES: unknown store(s) {', '.join(unknown)}; use {', '.join(PAYMENT_STORES)}")
    return tuple(s for s in stores if s in PAYMENT_STORES)


def _check_payments(settings: Settings) -> None:
    stores = settings.payment_stores
    if "mock" in stores and settings.is_production:
        raise ConfigError("PAYMENT_STORES=mock is not allowed in production (it grants paid plans without payment)")
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
