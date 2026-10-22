from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta
from typing import Any

from prisma.errors import UniqueViolationError

from ..auth import invalidate_user
from ..background import spawn
from ..config import env
from ..db import db
from ..errors import AppError, conflict, forbidden, unauthorized, unprocessable, validation_error
from ..http import now
from ..ids import new_id
from ..security import generate_refresh_token, hash_password, hash_password_sync, hash_token, sign_access_token, verify_password
from .audit_service import audit
from .geocoding_service import detect_service_area, find_service_area
from .mailer import send_email, send_in_background
from .mailer import templates as emails
from .settings_service import get_settings
from .subscription_service import create_inactive_subscription

# Same cost as real hashes, so a missing account takes as long to reject as a wrong password.
DUMMY_HASH = hash_password_sync("not-a-real-password", env.BCRYPT_ROUNDS)


def service_area_of(u: Any) -> dict | None:
    if not u or not u.areaCity or not u.areaCountryCode:
        return None
    return {"city": u.areaCity, "country": u.areaCountry or None, "countryCode": u.areaCountryCode, "latitude": u.areaLatitude,
            "longitude": u.areaLongitude, "source": str(u.areaSource) if u.areaSource else None, "confirmedAt": u.areaConfirmedAt}


def area_columns(area: dict | None, source: str | None = None) -> dict:
    if not area:
        return {k: None for k in ("areaCity", "areaCountry", "areaCountryCode", "areaLatitude", "areaLongitude", "areaSource", "areaConfirmedAt")}
    return {
        "areaCity": str(area["city"])[:120], "areaCountry": (str(area["country"])[:120] if area.get("country") else None),
        "areaCountryCode": str(area["countryCode"]).lower()[:2], "areaLatitude": float(area["latitude"]), "areaLongitude": float(area["longitude"]),
        "areaSource": source or area.get("source"), "areaConfirmedAt": now(),
    }


def serialize_user(u: Any) -> dict:
    return {
        "id": u.id, "fullName": u.fullName, "phone": u.phone, "email": u.email, "role": str(u.role),
        "currency": u.currency, "routePreference": str(u.routePreference), "notificationsEnabled": u.notificationsEnabled, "status": str(u.status),
        "serviceArea": service_area_of(u),
        "createdAt": u.createdAt,
    }


async def _assert_password_policy(password: str) -> None:
    minimum = (await get_settings())["security"]["minPasswordLength"]
    if len(password) < minimum:
        message = f"Password must be at least {minimum} characters"
        raise validation_error([{"path": "password", "message": message}], message)


async def create_rider_account(*, full_name: str, email: str, password: str, phone: str | None = None) -> Any:
    """Creates a rider account with its own free-trial subscription.

    Every rider is fully independent: there is no organization or team concept anywhere in this app.
    Runs in one transaction, so a failure never leaves a rider without a subscription.
    """
    await _assert_password_policy(password)
    settings = await get_settings()
    email = email.lower()
    if await db.user.find_unique(where={"email": email}):
        raise conflict("An account with this email already exists", "EMAIL_TAKEN")

    password_hash = await hash_password(password)
    user_id = new_id()
    try:
        user = await db.user.create(data={
            "id": user_id, "fullName": full_name, "phone": phone, "email": email, "passwordHash": password_hash, "role": "rider",
            "currency": settings["defaultCurrency"], "routePreference": settings["route"]["defaultPreference"],
        })
    except UniqueViolationError:
        raise conflict("An account with this email already exists", "EMAIL_TAKEN") from None
    try:
        await create_inactive_subscription(user_id)
    except Exception:
        await db.user.delete_many(where={"id": user_id})
        raise
    return user


async def _issue_tokens(user: Any, *, family: str | None = None, user_agent: str | None = None) -> dict:
    refresh_token = generate_refresh_token()
    await db.refreshtoken.create(data={
        "id": new_id(), "userId": user.id, "family": family or str(uuid.uuid4()), "tokenHash": hash_token(refresh_token),
        "expiresAt": now() + timedelta(days=env.REFRESH_TOKEN_TTL_DAYS), "userAgent": (user_agent or "")[:300] or None,
    })
    return {"accessToken": sign_access_token(user.id, str(user.role), user.tokenVersion), "expiresIn": env.ACCESS_TOKEN_TTL_SECONDS, "refreshToken": refresh_token}


async def register(data: dict, ctx: dict) -> dict:
    user = await create_rider_account(full_name=data["fullName"], email=data["email"], password=data["password"])
    tokens = await _issue_tokens(user, user_agent=ctx.get("userAgent"))
    await _send_welcome(user)
    return {"user": serialize_user(user), **tokens}


async def _send_welcome(user: Any) -> None:
    """Sent in the background: sign-up never waits on (or fails because of) the email provider."""
    platform = (await get_settings())["platform"]
    send_in_background(emails.welcome(to=user.email, name=user.fullName, platform=platform["name"], support_email=platform["supportEmail"] or None))


CLIENT_ROLE = {"mobile": "rider", "web": "owner_admin"}


# Failed-login counters for emails with no account, kept in the shared rate_limits table so they behave exactly
# like a real account's counter on every worker: a missing account locks out the same way (no enumeration).
_UNKNOWN_KEY = "login-unknown:{}"
_UNKNOWN_RESERVE_SQL = """
INSERT INTO "rate_limits" ("key", "count", "resetAt", "lockedUntil")
VALUES ($1, 1, timezone('utc', now()) + interval '30 days', NULL)
ON CONFLICT ("key") DO UPDATE SET
  "count"       = CASE WHEN "rate_limits"."lockedUntil" <= timezone('utc', now()) THEN 1 ELSE "rate_limits"."count" + 1 END,
  "lockedUntil" = CASE WHEN "rate_limits"."lockedUntil" <= timezone('utc', now()) THEN NULL ELSE "rate_limits"."lockedUntil" END,
  "resetAt"     = EXCLUDED."resetAt"
RETURNING "count", ("lockedUntil" IS NOT NULL) AS "locked"
"""


async def _unknown_email_locked(email: str) -> bool:
    rows = await db.query_raw("""SELECT 1 AS "locked" FROM "rate_limits" WHERE "key" = $1 AND "lockedUntil" > timezone('utc', now())""",
                              _UNKNOWN_KEY.format(email))
    return bool(rows)


async def _reserve_unknown_attempt(email: str, settings: dict) -> int:
    key = _UNKNOWN_KEY.format(email)
    row = (await db.query_raw(_UNKNOWN_RESERVE_SQL, key))[0]
    if int(row["count"]) >= settings["security"]["maxFailedLogins"] and not row["locked"]:
        await db.execute_raw("""UPDATE "rate_limits" SET "lockedUntil" = timezone('utc', now()) + make_interval(mins => $2::int) WHERE "key" = $1""",
                             key, settings["security"]["lockoutMinutes"])
    return int(row["count"])


def _locked_error() -> AppError:
    return AppError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.")


async def _reserve_attempt(user: Any, settings: dict) -> int:
    """Atomically counts this attempt before the password is checked, so parallel guesses cannot exceed the limit."""
    if user.lockedUntil and user.lockedUntil <= now():
        # The lockout has ended: start a fresh budget (only the first request to notice resets it).
        await db.user.update_many(where={"id": user.id, "lockedUntil": user.lockedUntil}, data={"failedLoginCount": 0, "lockedUntil": None})
    updated = await db.user.update(where={"id": user.id}, data={"failedLoginCount": {"increment": 1}})
    if updated.failedLoginCount >= settings["security"]["maxFailedLogins"] and not (updated.lockedUntil and updated.lockedUntil > now()):
        await db.user.update(where={"id": user.id}, data={"lockedUntil": now() + timedelta(minutes=settings["security"]["lockoutMinutes"])})
    return updated.failedLoginCount


async def login(*, email: str, password: str, client: str, ctx: dict) -> dict:
    settings = await get_settings()
    email = email.lower()
    user = await db.user.find_unique(where={"email": email})
    maximum = settings["security"]["maxFailedLogins"]

    if user:
        if user.lockedUntil and user.lockedUntil > now():
            await audit({"id": user.id, "email": user.email}, "auth.login", status="failure", meta={"reason": "locked"}, ip=ctx.get("ip"))
            raise _locked_error()
        attempt = await _reserve_attempt(user, settings)
    else:
        if await _unknown_email_locked(email):
            raise _locked_error()
        attempt = await _reserve_unknown_attempt(email, settings)
    if attempt > maximum:
        # Over budget (parallel guesses that raced past the lock check): refuse without checking the password.
        raise _locked_error()

    valid = await verify_password(password, user.passwordHash if user else DUMMY_HASH)
    if not user or not valid:
        if user and user.role == "owner_admin":
            await audit({"id": user.id, "email": user.email}, "auth.login", status="failure", ip=ctx.get("ip"))
        raise unauthorized("Incorrect email or password", "INVALID_CREDENTIALS")

    if user.status != "active":
        raise forbidden("Your account is suspended. Contact support.", "ACCOUNT_SUSPENDED")
    if CLIENT_ROLE[client] != user.role:
        raise forbidden("This console is for platform administrators only." if client == "web" else "Please sign in with a rider account.", "WRONG_CLIENT")

    user = await db.user.update(where={"id": user.id}, data={"failedLoginCount": 0, "lockedUntil": None, "lastActiveAt": now()})
    if user.role == "owner_admin":
        await audit({"id": user.id, "email": user.email}, "auth.login", ip=ctx.get("ip"))
    tokens = await _issue_tokens(user, user_agent=ctx.get("userAgent"))
    return {"user": serialize_user(user), **tokens}


async def refresh(presented: str | None, ctx: dict) -> dict:
    """Rotating refresh tokens with reuse detection: replaying a used token revokes the whole family."""
    if not presented:
        raise unauthorized("Refresh token required", "INVALID_REFRESH_TOKEN")
    record = await db.refreshtoken.find_unique(where={"tokenHash": hash_token(presented)})
    if not record:
        raise unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN")
    if record.revokedAt:
        await db.refreshtoken.update_many(where={"family": record.family, "revokedAt": None}, data={"revokedAt": now()})
        raise unauthorized("Refresh token was already used", "REFRESH_TOKEN_REUSED")
    if record.expiresAt < now():
        raise unauthorized("Refresh token expired", "INVALID_REFRESH_TOKEN")

    user = await db.user.find_unique(where={"id": record.userId})
    if not user or user.status != "active":
        raise forbidden("Your account is suspended", "ACCOUNT_SUSPENDED")

    # Revoke the presented token atomically so two parallel refreshes cannot both succeed.
    claimed = await db.refreshtoken.update_many(where={"id": record.id, "revokedAt": None}, data={"revokedAt": now()})
    if not claimed:
        await db.refreshtoken.update_many(where={"family": record.family, "revokedAt": None}, data={"revokedAt": now()})
        raise unauthorized("Refresh token was already used", "REFRESH_TOKEN_REUSED")
    nxt = await _issue_tokens(user, family=record.family, user_agent=ctx.get("userAgent"))
    await db.refreshtoken.update(where={"id": record.id}, data={"replacedByHash": hash_token(nxt["refreshToken"])})
    return {"user": serialize_user(user), **nxt}


async def logout(presented: str | None) -> None:
    if not presented:
        return
    record = await db.refreshtoken.find_unique(where={"tokenHash": hash_token(presented)})
    if record:
        await db.refreshtoken.update_many(where={"family": record.family, "revokedAt": None}, data={"revokedAt": now()})


async def get_profile(user_id: str) -> dict:
    user = await db.user.find_unique(where={"id": user_id})
    if not user:
        raise unauthorized("Account no longer exists", "INVALID_TOKEN")
    return serialize_user(user)


async def update_profile(user_id: str, patch: dict) -> dict:
    data = {k: v for k, v in patch.items() if k != "city"}
    if "city" in patch:
        city = patch["city"]
        if not city:
            data.update(area_columns(None))
        else:
            area = await find_service_area(city)
            if not area:
                raise validation_error([{"path": "city", "message": 'We could not find that city. Try adding the country, e.g. "Lahore, Pakistan".'}])
            data.update(area_columns(area, "manual"))
    user = await db.user.update(where={"id": user_id}, data=data) if data else await db.user.find_unique(where={"id": user_id})
    invalidate_user(user_id)
    return serialize_user(user)


async def preview_service_area(point: dict) -> dict:
    """Looks up the city at a GPS point without saving it, so the app can ask the rider first."""
    area = await detect_service_area(point)
    if not area:
        raise unprocessable("We could not detect a city at your location", "AREA_NOT_FOUND")
    return area


async def confirm_service_area(user_id: str, point: dict) -> dict:
    """Saves the city detected at a GPS point as the rider's service area."""
    area = await preview_service_area(point)
    return serialize_user(await db.user.update(where={"id": user_id}, data=area_columns(area, "gps")))


async def change_password(user_id: str, current_password: str, new_password: str, ctx: dict) -> dict:
    """Signs out every other session at once (access tokens included) and returns fresh tokens for this one."""
    if current_password == new_password:
        raise unprocessable("Your new password must be different from your current password. "
                            "Enter your old password in the first box and the new one in the second.", "SAME_PASSWORD")
    await _assert_password_policy(new_password)
    user = await db.user.find_unique(where={"id": user_id})
    if not await verify_password(current_password, user.passwordHash):
        raise unprocessable("Current password is incorrect", "INVALID_CREDENTIALS")
    await db.refreshtoken.update_many(where={"userId": user.id, "revokedAt": None}, data={"revokedAt": now()})
    user = await db.user.update(where={"id": user.id}, data={"passwordHash": await hash_password(new_password), "tokenVersion": {"increment": 1}})
    invalidate_user(user.id)
    await _notify_password_changed(user)
    return {"changed": True, **await _issue_tokens(user, user_agent=ctx.get("userAgent"))}


async def _notify_password_changed(user: Any) -> None:
    platform = (await get_settings())["platform"]
    send_in_background(emails.password_changed(to=user.email, name=user.fullName, platform=platform["name"], support_email=platform["supportEmail"] or None))


# ---------- Forgot password ----------
# A 6-digit code is emailed (typed into the app, so no deep links are needed). Only its HMAC is stored, each code allows
# RESET_MAX_ATTEMPTS guesses, and requesting a new code kills the old one, so guessing is hopeless within the code's lifetime.

RESET_MAX_ATTEMPTS = 5


def _reset_code_hash(user_id: str, code: str) -> str:
    return hmac.new(env.JWT_REFRESH_SECRET.encode(), f"password-reset:{user_id}:{code}".encode(), hashlib.sha256).hexdigest()


def _invalid_reset_code() -> AppError:
    return AppError(400, "INVALID_RESET_CODE", "This code is invalid or has expired. Request a new one.")


def request_password_reset(email: str, ctx: dict) -> None:
    """Answers at once and does the work in the background: the response looks and takes the same whether or not the email exists."""
    spawn(_send_reset_code(email.lower(), ctx.get("ip")), "password reset email")


async def _send_reset_code(email: str, ip: str | None) -> None:
    user = await db.user.find_unique(where={"email": email})
    if not user or user.status != "active":
        return
    code = f"{secrets.randbelow(1_000_000):06d}"
    await db.passwordreset.update_many(where={"userId": user.id, "usedAt": None}, data={"usedAt": now()})
    await db.passwordreset.create(data={
        "id": new_id(), "userId": user.id, "codeHash": _reset_code_hash(user.id, code),
        "expiresAt": now() + timedelta(minutes=env.PASSWORD_RESET_TTL_MINUTES), "ip": (ip or "")[:64] or None,
    })
    platform = (await get_settings())["platform"]
    await send_email(emails.password_reset_code(to=user.email, name=user.fullName, code=code, minutes=env.PASSWORD_RESET_TTL_MINUTES,
                                                platform=platform["name"]))
    await audit({"id": user.id, "email": user.email}, "auth.password_reset_requested", ip=ip)


async def _check_reset_code(email: str, code: str) -> tuple[Any, Any]:
    """Counts the attempt before comparing, so parallel guesses cannot exceed the budget. Every failure looks the same."""
    user = await db.user.find_unique(where={"email": email.lower()})
    reset = await db.passwordreset.find_first(where={"userId": user.id, "usedAt": None, "expiresAt": {"gt": now()}},
                                              order={"createdAt": "desc"}) if user and user.status == "active" else None
    expected = _reset_code_hash(user.id if user else "-", code)
    if not reset:
        raise _invalid_reset_code()
    claimed = await db.passwordreset.update_many(where={"id": reset.id, "usedAt": None, "attempts": {"lt": RESET_MAX_ATTEMPTS}},
                                                 data={"attempts": {"increment": 1}})
    if not claimed:
        raise _invalid_reset_code()
    if not hmac.compare_digest(reset.codeHash, expected):
        if reset.attempts + 1 >= RESET_MAX_ATTEMPTS:
            await db.passwordreset.update_many(where={"id": reset.id, "usedAt": None}, data={"usedAt": now()})
        raise _invalid_reset_code()
    return user, reset


async def verify_reset_code(email: str, code: str) -> dict:
    """Lets the app confirm the code before asking for the new password. The code stays valid for the reset itself."""
    _, reset = await _check_reset_code(email, code)
    await db.passwordreset.update(where={"id": reset.id}, data={"attempts": 0})
    return {"valid": True, "expiresAt": reset.expiresAt}


async def reset_password(email: str, code: str, new_password: str, ctx: dict) -> dict:
    """Sets the new password, signs out every session and clears any login lockout. The rider then signs in normally."""
    await _assert_password_policy(new_password)
    user, reset = await _check_reset_code(email, code)
    if not await db.passwordreset.update_many(where={"id": reset.id, "usedAt": None}, data={"usedAt": now()}):
        raise _invalid_reset_code()  # a parallel request used it first
    await db.passwordreset.update_many(where={"userId": user.id, "usedAt": None}, data={"usedAt": now()})
    await db.refreshtoken.update_many(where={"userId": user.id, "revokedAt": None}, data={"revokedAt": now()})
    user = await db.user.update(where={"id": user.id}, data={
        "passwordHash": await hash_password(new_password), "tokenVersion": {"increment": 1}, "failedLoginCount": 0, "lockedUntil": None,
    })
    invalidate_user(user.id)
    await audit({"id": user.id, "email": user.email}, "auth.password_reset", ip=ctx.get("ip"))
    await _notify_password_changed(user)
    return {"reset": True}
