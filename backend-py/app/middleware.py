"""ASGI middleware reproducing the Express stack: request id → logging → helmet → cors → /api/v1 rate limit."""
from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import env
from .errors import AppError, error_body
from .http import dumps
from .logger import log

_REQUEST_ID_RE = re.compile(r"^[\w-]{8,64}$")
_SECRET_QUERY = re.compile(r"(?i)(?<![\w])(sig|token|code|refreshToken|password)=[^&]*")


def _loggable_url(raw: str) -> str:
    """The access log keeps the path and query but not credentials such as a signed URL's `sig`."""
    return _SECRET_QUERY.sub(lambda m: f"{m.group(1)}=[redacted]", raw)

# The same defaults helmet() applied in the Node API.
HELMET_HEADERS = {
    "content-security-policy": "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';"
                               "img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';"
                               "upgrade-insecure-requests",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "x-download-options": "noopen",
    "x-frame-options": "SAMEORIGIN",
    "x-permitted-cross-domain-policies": "none",
    "x-xss-protection": "0",
}

# Swagger UI (development only: /docs is disabled in production) loads its bundle from jsDelivr and boots with an inline script.
DOCS_PATHS = ("/docs", "/docs/oauth2-redirect")
DOCS_HEADERS = {
    **HELMET_HEADERS,
    "content-security-policy": "default-src 'self';base-uri 'self';frame-ancestors 'self';object-src 'none';connect-src 'self';"
                               "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;"
                               "img-src 'self' data: https://fastapi.tiangolo.com https://cdn.jsdelivr.net",
}


def client_ip(scope: Scope) -> str:
    """Express `req.ip` with `trust proxy` set to a hop count."""
    socket_ip = (scope.get("client") or ("", 0))[0] or ""
    hops = env.TRUST_PROXY
    if not hops:
        return socket_ip
    forwarded = Headers(scope=scope).get("x-forwarded-for", "")
    chain = [socket_ip, *reversed([p.strip() for p in forwarded.split(",") if p.strip()])]
    return chain[min(hops, len(chain) - 1)]


def json_error(status: int, code: str, message: str, details=None) -> tuple[int, bytes]:
    return status, dumps(error_body(code, message, details))


async def _send_json(send: Send, status: int, body: bytes, extra: dict | None = None) -> None:
    headers = [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())]
    headers += [(k.encode(), str(v).encode()) for k, v in (extra or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _raw_url(scope: Scope) -> str:
    query = scope.get("query_string", b"")
    raw = scope.get("raw_path", b"").decode(errors="replace")
    return f"{raw}?{query.decode(errors='replace')}" if query and raw and "?" not in raw else raw


class EdgeMiddleware:
    """Outermost layer: request id, access log, security headers, trailing-slash tolerance and last-resort error handling."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        incoming = Headers(scope=scope).get("x-request-id")
        request_id = incoming if incoming and _REQUEST_ID_RE.match(incoming) else str(uuid.uuid4())
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        state["ip"] = client_ip(scope)
        # Express routing is not strict about trailing slashes: /api/v1/auth/me/ == /api/v1/auth/me
        path = scope.get("path", "/")
        if len(path) > 1 and path.endswith("/"):
            scope["path"] = path.rstrip("/") or "/"

        started = time.perf_counter()
        status_holder = {"status": 500, "started": False}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder.update(status=message["status"], started=True)
                headers = MutableHeaders(scope=message)
                for key, value in (DOCS_HEADERS if scope.get("path") in DOCS_PATHS else HELMET_HEADERS).items():
                    if key not in headers:
                        headers[key] = value
                headers["x-request-id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:  # noqa: BLE001
            log(logging.ERROR, "Unhandled error", requestId=request_id, exc_info=True)
            if not status_holder["started"]:
                status, body = json_error(500, "INTERNAL_ERROR", "The server could not complete the request")
                await _send_json(send_wrapper, status, body)
        finally:
            status = status_holder["status"]
            level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
            log(level, "request completed", reqId=request_id, method=scope.get("method"), url=_loggable_url(_raw_url(scope)) or path,
                statusCode=status, responseTime=round((time.perf_counter() - started) * 1000))


# One atomic upsert per hit: the count lives in PostgreSQL, so all API workers (and restarts) share it.
_HIT_SQL = """
INSERT INTO "rate_limits" ("key", "count", "resetAt")
VALUES ($1, 1, timezone('utc', now()) + make_interval(secs => $2::int))
ON CONFLICT ("key") DO UPDATE SET
  "count"   = CASE WHEN "rate_limits"."resetAt" <= timezone('utc', now()) THEN 1 ELSE "rate_limits"."count" + 1 END,
  "resetAt" = CASE WHEN "rate_limits"."resetAt" <= timezone('utc', now()) THEN EXCLUDED."resetAt" ELSE "rate_limits"."resetAt" END
RETURNING "count", GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("resetAt" - timezone('utc', now())))))::int AS "resetIn"
"""


class RateLimiter:
    """Fixed-window limiter per key (normally the client IP), shared by every worker through the database."""

    def __init__(self, name: str, window_seconds: int, limit: int, message: str = "Too many requests. Please slow down and try again shortly.",
                 *, enforce: bool | None = None):
        self.name = name
        self.window = window_seconds
        self.limit = limit
        self.message = message
        self.enforce = enforce  # None: on everywhere except NODE_ENV=test

    async def hit(self, key: str) -> tuple[int, int]:
        """Counts one hit and returns (hits in this window, seconds until the window resets)."""
        from .db import db

        rows = await db.query_raw(_HIT_SQL, f"{self.name}:{key}"[:300], self.window)
        return int(rows[0]["count"]), int(rows[0]["resetIn"])

    def _enforced(self) -> bool:
        return self.enforce if self.enforce is not None else not env.is_test

    async def exceeded(self, key: str) -> bool:
        """True when this key already used up its window, without counting a hit."""
        from .db import db

        if not self._enforced():
            return False
        try:
            rows = await db.query_raw("""SELECT "count" FROM "rate_limits" WHERE "key" = $1 AND "resetAt" > timezone('utc', now())""",
                                      f"{self.name}:{key}"[:300])
        except Exception:  # noqa: BLE001
            log(logging.ERROR, "Rate limiter unavailable", limiter=self.name, exc_info=True)
            return False
        return bool(rows) and int(rows[0]["count"]) >= self.limit

    async def check(self, key: str) -> dict[str, str]:
        """Counts a hit; raises 429 when over the limit. Returns the RateLimit headers to send."""
        if not self._enforced():
            return {}
        try:
            count, reset_in = await self.hit(key)
        except Exception:  # noqa: BLE001 - a limiter outage must not take the API down with it
            log(logging.ERROR, "Rate limiter unavailable", limiter=self.name, exc_info=True)
            return {}
        policy = f"{self.limit}-in-{self.window // 60}min"
        headers = {"RateLimit-Policy": f'"{policy}"; q={self.limit}; w={self.window}',
                   "RateLimit": f'"{policy}"; r={max(0, self.limit - count)}; t={reset_in}'}
        if count > self.limit:
            raise AppError(429, "RATE_LIMITED", self.message)
        return headers


api_limiter = RateLimiter("api", 15 * 60, 1000)
auth_limiter = RateLimiter("auth", 15 * 60, 40)
upload_limiter = RateLimiter("upload", 15 * 60, 120)
# The camera checks each label it reads; this keeps a stuck scan loop from flooding the geocoder.
geocode_limiter = RateLimiter("geocode", 15 * 60, 200, "Too many address checks. Wait a moment and try again.")
# Suggestions are requested while the rider types, so they get a bigger allowance than full lookups.
suggest_limiter = RateLimiter("geocode-suggest", 15 * 60, 1500, "Too many address searches. Wait a moment and try again.")
# Registration has to say when an email is taken (it signs the rider straight in), so cap how often one IP can learn that.
email_taken_limiter = RateLimiter("email-taken", 60 * 60, 5, "Too many sign-up attempts. Please try again later or sign in instead.")
# Keyed by the email address, not the IP: caps the codes one inbox can receive.
reset_email_limiter = RateLimiter("reset-email", 60 * 60, 5, "Too many reset requests for this email. Please try again later.")


async def limit(request: Request, limiter: RateLimiter) -> None:
    await limiter.check(request.state.ip)


class ApiRateLimitMiddleware:
    """Applies the general /api/v1 limit (inside CORS, so preflight requests are never counted)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/v1"):
            return await self.app(scope, receive, send)
        try:
            headers = await api_limiter.check(scope.get("state", {}).get("ip", ""))
        except AppError as error:
            status, body = json_error(error.status, error.code, error.message)
            return await _send_json(send, status, body)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start" and headers:
                mh = MutableHeaders(scope=message)
                for key, value in headers.items():
                    mh[key] = value
            await send(message)

        await self.app(scope, receive, send_wrapper)



JSON_BODY_LIMIT = 1024 * 1024
UPLOAD_BODY_LIMIT = 11 * 1024 * 1024  # largest upload (10 MB document) plus multipart overhead
_UPLOAD_PATH = re.compile(r"^/api/v1/deliveries/(import/(pdf|file)|[0-9a-fA-F]{24}/proof)$")


class BodyTooLarge(AppError):
    def __init__(self):
        super().__init__(413, "PAYLOAD_TOO_LARGE", "Request body is too large")


class BodyLimitMiddleware:
    """Rejects oversized bodies before they are buffered: by Content-Length up front, and while streaming for chunked bodies."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = UPLOAD_BODY_LIMIT if _UPLOAD_PATH.match(scope.get("path", "")) else JSON_BODY_LIMIT
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            status, body = json_error(413, "PAYLOAD_TOO_LARGE", "Request body is too large")
            return await _send_json(send, status, body, {"connection": "close"})

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge()
            return message

        await self.app(scope, limited_receive, send)
