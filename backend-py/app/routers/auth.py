from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Request
from pydantic import StringConstraints, model_validator

from ..auth import authenticate, ctx
from ..config import env
from ..errors import AppError, unauthorized
from ..http import ApiJSONResponse, ok, respond
from ..middleware import auth_limiter, email_taken_limiter, limit
from ..services import auth_service as auth
from ..validation import Currency, Email, Phone, Schema, Trimmed, validate

router = APIRouter(prefix="/auth")
COOKIE = "dp_rt"
Password = Annotated[str, StringConstraints(min_length=6, max_length=128)]


class RegisterBody(Schema):
    fullName: Trimmed(2, 120)
    phone: Phone
    email: Email
    password: Password
    confirmPassword: str
    currency: Currency

    @model_validator(mode="after")
    def passwords_match(self):
        if self.password != self.confirmPassword:
            raise ValueError("Passwords do not match")
        return self


class LoginBody(Schema):
    email: Email
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    client: Literal["mobile", "web"] = "mobile"


class RefreshBody(Schema):
    refreshToken: Optional[Annotated[str, StringConstraints(min_length=20, max_length=200)]] = None
    client: Literal["mobile", "web"] = "mobile"


class ProfileBody(Schema):
    nullable_fields = frozenset({"city"})
    fullName: Optional[Trimmed(2, 120)] = None
    phone: Optional[Phone] = None
    currency: Optional[Currency] = None
    routePreference: Optional[Literal["smart", "nearest_first", "shortest"]] = None
    notificationsEnabled: Optional[bool] = None
    # A city name sets the rider's service area by hand; null clears it so GPS detection takes over.
    city: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]] = None

    @model_validator(mode="after")
    def not_empty(self):
        if not self.model_fields_set:
            raise ValueError("Nothing to update")
        return self


class PasswordBody(Schema):
    currentPassword: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    newPassword: Password
    client: Literal["mobile", "web"] = "mobile"


def _cookie_kwargs() -> dict:
    return {"httponly": True, "secure": env.cookie_secure, "samesite": env.COOKIE_SAMESITE, "path": "/api/v1/auth"}


def _respond(result: dict, client: str, status: int = 200) -> ApiJSONResponse:
    """Web clients get the refresh token as an httpOnly cookie; mobile clients receive it in the JSON body."""
    refresh_token = result.pop("refreshToken")
    if client == "web":
        response = ApiJSONResponse(ok(result), status_code=status)
        max_age = env.REFRESH_TOKEN_TTL_DAYS * 86_400
        response.set_cookie(COOKIE, refresh_token, max_age=max_age, expires=max_age, **_cookie_kwargs())
        return response
    return ApiJSONResponse(ok({**result, "refreshToken": refresh_token}), status_code=status)


def _require_csrf_header(request: Request) -> None:
    if request.cookies.get(COOKIE) and request.headers.get("x-requested-with") != "XMLHttpRequest":
        raise unauthorized("Missing X-Requested-With header", "CSRF_BLOCKED")


@router.post("/register")
async def register(request: Request):
    await limit(request, auth_limiter)
    body = (await validate(request, body=RegisterBody))["body"]
    # An IP that keeps hitting taken emails is probing for accounts: once over the cap it is refused whether or not
    # the next email is free, so the 429 itself tells it nothing.
    if await email_taken_limiter.exceeded(request.state.ip):
        raise AppError(429, "RATE_LIMITED", email_taken_limiter.message)
    data = body.model_dump(exclude={"confirmPassword"})
    try:
        return _respond(await auth.register(data, ctx(request)), "mobile", 201)
    except AppError as error:
        if error.code == "EMAIL_TAKEN":
            await email_taken_limiter.check(request.state.ip)
        raise


@router.post("/login")
async def login(request: Request):
    await limit(request, auth_limiter)
    body = (await validate(request, body=LoginBody))["body"]
    return _respond(await auth.login(email=body.email, password=body.password, client=body.client, ctx=ctx(request)), body.client)


@router.post("/refresh")
async def refresh(request: Request):
    await limit(request, auth_limiter)
    body = (await validate(request, body=RefreshBody))["body"]
    presented = body.refreshToken
    if body.client == "web":
        _require_csrf_header(request)
        presented = request.cookies.get(COOKIE)
    return _respond(await auth.refresh(presented, ctx(request)), body.client)


@router.post("/logout")
async def logout(request: Request):
    body = (await validate(request, body=RefreshBody))["body"]
    if body.client == "web":
        _require_csrf_header(request)
    await auth.logout(request.cookies.get(COOKIE) if body.client == "web" else body.refreshToken)
    response = respond({"loggedOut": True})
    if body.client == "web":
        response.delete_cookie(COOKIE, **_cookie_kwargs())
    return response


@router.get("/me")
async def me(request: Request):
    actor = await authenticate(request)
    return respond(await auth.get_profile(actor["id"]))


@router.patch("/me")
async def update_me(request: Request):
    actor = await authenticate(request)
    body = (await validate(request, body=ProfileBody))["body"]
    return respond(await auth.update_profile(actor["id"], body.provided()))


@router.post("/change-password")
async def change_password(request: Request):
    await limit(request, auth_limiter)
    actor = await authenticate(request)
    body = (await validate(request, body=PasswordBody))["body"]
    # Every older session (and access token) is now dead; this one continues with the fresh tokens returned here.
    return _respond(await auth.change_password(actor["id"], body.currentPassword, body.newPassword, ctx(request)), body.client)

