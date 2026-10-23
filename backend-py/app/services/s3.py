"""A small S3 client (AWS Signature Version 4) for Cloudflare R2 or any S3-compatible store, on httpx.

Only what file storage needs: put, get, head, delete and presigned GET links. Path-style URLs
({S3_ENDPOINT}/{bucket}/{key}), which R2 and MinIO accept. The signing functions are pure and checked against the
examples in AWS's SigV4 documentation (tests/test_storage.py).
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit

import httpx

from ..config import env

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
UNSIGNED = "UNSIGNED-PAYLOAD"
TIMEOUT = 30.0
_transport: httpx.AsyncBaseTransport | None = None  # tests swap in a fake S3


def set_transport_for_tests(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret: str, day: str, region: str, service: str = "s3") -> bytes:
    return _hmac(_hmac(_hmac(_hmac(f"AWS4{secret}".encode(), day), region), service), "aws4_request")


def _encode(value: str, *, safe: str = "-_.~") -> str:
    return quote(value, safe=safe)


def canonical_query(params: dict[str, str]) -> str:
    return "&".join(f"{_encode(k)}={_encode(v)}" for k, v in sorted(params.items()))


def signature(*, method: str, path: str, query: dict[str, str], headers: dict[str, str], payload_hash: str, amz_date: str, region: str,
              secret: str) -> tuple[str, str]:
    """(signature, signed headers) for a request. `path` is already URI-encoded; header names lower-case."""
    signed = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{' '.join(str(headers[k]).split())}\n" for k in sorted(headers))
    request = "\n".join([method, path, canonical_query(query), canonical_headers, signed, payload_hash])
    day = amz_date[:8]
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(request.encode()).hexdigest()])
    return hmac.new(_signing_key(secret, day, region), to_sign.encode(), hashlib.sha256).hexdigest(), signed


def presigned_query(*, method: str, host: str, path: str, region: str, access_key: str, secret: str, amz_date: str, expires: int,
                    extra: dict[str, str] | None = None) -> dict[str, str]:
    """The query string (as a dict) that makes `method host path` usable without credentials for `expires` seconds."""
    query = {
        **(extra or {}),
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{amz_date[:8]}/{region}/s3/aws4_request",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    sig, _ = signature(method=method, path=path, query=query, headers={"host": host}, payload_hash=UNSIGNED, amz_date=amz_date,
                       region=region, secret=secret)
    return {**query, "X-Amz-Signature": sig}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _object(key: str) -> tuple[str, str, str]:
    """(url, host, encoded path) of an object."""
    endpoint = env.S3_ENDPOINT.rstrip("/")
    path = "/" + _encode(env.S3_BUCKET, safe="-_.~") + "/" + _encode(key, safe="-_.~/")
    parts = urlsplit(endpoint)
    return f"{endpoint}{path}", parts.netloc, path


async def _send(method: str, key: str, body: bytes = b"", extra_headers: dict[str, str] | None = None) -> httpx.Response:
    url, host, path = _object(key)
    amz_date = _now()
    payload_hash = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
    headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date, **{k.lower(): v for k, v in (extra_headers or {}).items()}}
    sig, signed = signature(method=method, path=path, query={}, headers=headers, payload_hash=payload_hash, amz_date=amz_date,
                            region=env.S3_REGION, secret=env.S3_SECRET_ACCESS_KEY)
    auth = f"AWS4-HMAC-SHA256 Credential={env.S3_ACCESS_KEY_ID}/{amz_date[:8]}/{env.S3_REGION}/s3/aws4_request, SignedHeaders={signed}, Signature={sig}"
    sent = {k: v for k, v in headers.items() if k != "host"} | {"Authorization": auth}
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=_transport) as client:
        return await client.request(method, url, content=body or None, headers=sent)


async def put(key: str, data: bytes, content_type: str) -> None:
    res = await _send("PUT", key, data, {"content-type": content_type})
    if res.status_code >= 300:
        raise RuntimeError(f"S3 PUT {key} answered {res.status_code}: {res.text[:200]}")


async def get(key: str) -> bytes | None:
    res = await _send("GET", key)
    if res.status_code == 404:
        return None
    if res.status_code >= 300:
        raise RuntimeError(f"S3 GET {key} answered {res.status_code}")
    return res.content


async def head(key: str) -> int | None:
    """The object's size, or None when it is not there."""
    res = await _send("HEAD", key)
    if res.status_code == 404:
        return None
    if res.status_code >= 300:
        raise RuntimeError(f"S3 HEAD {key} answered {res.status_code}")
    return int(res.headers.get("content-length", 0))


async def delete(key: str) -> None:
    res = await _send("DELETE", key)
    if res.status_code >= 300 and res.status_code != 404:
        raise RuntimeError(f"S3 DELETE {key} answered {res.status_code}")


def presigned_get(key: str, expires: int, *, content_type: str | None = None, disposition: str | None = None) -> str:
    """A link the phone can open directly (the photo or PDF comes from the store, not through the API)."""
    url, host, path = _object(key)
    extra = {}
    if content_type:
        extra["response-content-type"] = content_type
    if disposition:
        extra["response-content-disposition"] = disposition
    query = presigned_query(method="GET", host=host, path=path, region=env.S3_REGION, access_key=env.S3_ACCESS_KEY_ID,
                            secret=env.S3_SECRET_ACCESS_KEY, amz_date=_now(), expires=expires, extra=extra)
    return f"{url}?{canonical_query(query)}"
