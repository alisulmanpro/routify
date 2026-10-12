"""ASGI middleware reproducing the Express stack: request id → logging → helmet → cors → /api/v1 rate limit."""
from __future__ import annotations

import logging
import math
import re
import time
import uuid
from collections import defaultdict

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import env
from .errors import AppError, error_body
from .http import dumps
from .logger import log

_REQUEST_ID_RE = re.compile(r"^[\w-]{8,64}$")

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
                for key, value in HELMET_HEADERS.items():
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
            log(level, "request completed", reqId=request_id, method=scope.get("method"), url=scope.get("raw_path", b"").decode(errors="replace") or path,
                statusCode=status, responseTime=round((time.perf_counter() - started) * 1000))


class _Window:
    __slots__ = ("count", "reset")

    def __init__(self, reset: float):
        self.count = 0
        self.reset = reset


class RateLimiter:
    """Fixed-window limiter per client IP, like express-rate-limit's default memory store."""

    def __init__(self, name: str, window_seconds: int, limit: int):
        self.name = name
        self.window = window_seconds
        self.limit = limit
        self.hits: dict[str, _Window] = defaultdict(lambda: _Window(time.monotonic() + self.window))

    def check(self, ip: str) -> dict[str, str]:
        """Counts a hit; raises 429 when over the limit. Returns the RateLimit headers to send."""
        if env.is_test:
            return {}
        current = time.monotonic()
        if len(self.hits) > 50_000:
            for key in [k for k, w in self.hits.items() if w.reset <= current]:
                del self.hits[key]
        window = self.hits[ip]
        if window.reset <= current:
            window.count, window.reset = 0, current + self.window
        window.count += 1
        reset_in = max(0, math.ceil(window.reset - current))
        policy = f"{self.limit}-in-{self.window // 60}min"
        headers = {"RateLimit-Policy": f'"{policy}"; q={self.limit}; w={self.window}',
                   "RateLimit": f'"{policy}"; r={max(0, self.limit - window.count)}; t={reset_in}'}
        if window.count > self.limit:
            raise AppError(429, "RATE_LIMITED", "Too many requests. Please slow down and try again shortly.")
        return headers


api_limiter = RateLimiter("api", 15 * 60, 1000)
auth_limiter = RateLimiter("auth", 15 * 60, 40)
upload_limiter = RateLimiter("upload", 15 * 60, 120)


def limit(request: Request, limiter: RateLimiter) -> None:
    limiter.check(request.state.ip)


class ApiRateLimitMiddleware:
    """Applies the general /api/v1 limit (inside CORS, so preflight requests are never counted)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/v1"):
            return await self.app(scope, receive, send)
        try:
            headers = api_limiter.check(scope.get("state", {}).get("ip", ""))
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

