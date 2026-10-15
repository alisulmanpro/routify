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
    ROUTING_PROVIDER: str
    ROUTING_TRAVEL_MODE: str
    OSRM_URL: str
    ADMIN_EMAIL: str | None
    ADMIN_PASSWORD: str | None
    ADMIN_NAME: str

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
        ROUTING_PROVIDER=_enum("ROUTING_PROVIDER", ("google", "osrm", "none"), "google" if _str("GOOGLE_MAPS_API_KEY") else "osrm"),
        ROUTING_TRAVEL_MODE=_enum("ROUTING_TRAVEL_MODE", ("BICYCLE", "DRIVE", "TWO_WHEELER"), "BICYCLE"),
        OSRM_URL=_str("OSRM_URL", "https://router.project-osrm.org") or "https://router.project-osrm.org",
        ADMIN_EMAIL=admin_email,
        ADMIN_PASSWORD=admin_password,
        ADMIN_NAME=_str("ADMIN_NAME", "Platform Admin") or "Platform Admin",
    )

    if _problems:
        raise ConfigError("Invalid environment configuration:\n" + "\n".join(_problems) + "\nSee backend-py/.env.example")
    if settings.GEOCODING_PROVIDER == "nominatim" and not settings.GEOCODING_USER_AGENT and is_production:
        raise ConfigError("GEOCODING_USER_AGENT is required for Nominatim (identify your app + contact email)")
    if settings.GEOCODING_PROVIDER == "google" and not settings.GOOGLE_MAPS_API_KEY:
        raise ConfigError("GOOGLE_MAPS_API_KEY is required when GEOCODING_PROVIDER=google")
    if settings.ROUTING_PROVIDER == "google" and not settings.GOOGLE_MAPS_API_KEY:
        raise ConfigError("GOOGLE_MAPS_API_KEY is required when ROUTING_PROVIDER=google")
    if is_production and settings.COOKIE_SAMESITE == "none" and cookie_secure is False:
        raise ConfigError("COOKIE_SAMESITE=none requires COOKIE_SECURE=true")
    return settings


env = load_settings()
