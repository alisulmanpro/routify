"""Passwords, JWT access tokens, refresh tokens and signed file URLs.

Every format here matches the Node API byte for byte, so tokens issued before the switch keep working.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import time

import bcrypt
import jwt

from .config import env
from .errors import unauthorized

ISSUER = "delivery-planner"


# ---- Passwords (bcryptjs-compatible: it silently uses only the first 72 bytes) ----

def _pw(password: str) -> bytes:
    return password.encode("utf-8")[:72]


def hash_password_sync(password: str, rounds: int | None = None) -> str:
    return bcrypt.hashpw(_pw(password), bcrypt.gensalt(rounds or env.BCRYPT_ROUNDS)).decode()


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(hash_password_sync, password)


def _check(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_pw(password), hashed.encode())
    except ValueError:
        return False


async def verify_password(password: str, hashed: str) -> bool:
    return await asyncio.to_thread(_check, password, hashed)


# ---- Access tokens ----

def sign_access_token(user_id: str, role: str) -> str:
    issued = int(time.time())
    claims = {"role": role, "iat": issued, "exp": issued + env.ACCESS_TOKEN_TTL_SECONDS, "iss": ISSUER, "sub": str(user_id)}
    return jwt.encode(claims, env.JWT_ACCESS_SECRET, algorithm="HS256")


def verify_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, env.JWT_ACCESS_SECRET, algorithms=["HS256"], issuer=ISSUER, options={"require": ["sub"]})
    except jwt.ExpiredSignatureError:
        raise unauthorized("Access token expired", "TOKEN_EXPIRED") from None
    except jwt.PyJWTError:
        raise unauthorized("Invalid access token", "INVALID_TOKEN") from None


# ---- Refresh tokens ----

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_refresh_token() -> str:
    return b64url(secrets.token_bytes(48))


def hash_token(token: str) -> str:
    return hmac.new(env.JWT_REFRESH_SECRET.encode(), token.encode(), hashlib.sha256).hexdigest()


# ---- Signed file URLs ----

def _mac(key: str, exp: str | int, disposition: str) -> str:
    return b64url(hmac.new(env.FILE_SIGNING_SECRET.encode(), f"{key}.{exp}.{disposition}".encode(), hashlib.sha256).digest())


def sign_file_url(key: str | None, *, download: bool = False, ttl: int | None = None) -> str | None:
    """Returns an API-relative URL; clients resolve it against their API origin."""
    if not key:
        return None
    exp = int(time.time()) + (ttl or env.SIGNED_URL_TTL_SECONDS)
    disposition = "attachment" if download else "inline"
    return f"/api/v1/files/{key}?exp={exp}&d={disposition}&sig={_mac(key, exp, disposition)}"


def verify_file_signature(key: str, exp: str | None, disposition: str | None, sig: str | None) -> bool:
    if not key or not exp or not sig or disposition not in ("inline", "attachment"):
        return False
    try:
        if float(exp) < int(time.time()):
            return False
    except ValueError:
        return False
    return hmac.compare_digest(_mac(key, exp, disposition).encode(), str(sig).encode())
