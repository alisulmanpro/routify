"""Security tests: every endpoint's auth/role gate, cross-rider isolation, token handling, file URLs, uploads and abuse cases.

Each test asserts the secure behaviour, so a failure here is a security finding.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import time
import zipfile

import jwt
import pytest

from app.config import env
from app.db import db
from app.services import geocoding_service

from .test_api import PASSWORD, delivery, make_admin, rider

FAKE_ID = "0123456789abcdef01234567"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64

# (method, path, needs) for every /api/v1 route. needs: "public" | "any" | "rider" | "admin"
ENDPOINTS = [
    ("GET", "/api/v1/config", "public"),
    ("GET", "/api/v1/auth/me", "any"),
    ("PATCH", "/api/v1/auth/me", "any"),
    ("POST", "/api/v1/auth/change-password", "any"),
    ("POST", "/api/v1/deliveries/import/pdf", "rider"),
    ("POST", "/api/v1/deliveries/import/file", "rider"),
    ("POST", "/api/v1/deliveries/manual", "rider"),
    ("POST", "/api/v1/deliveries/bulk", "rider"),
    ("GET", "/api/v1/deliveries", "rider"),
    ("DELETE", "/api/v1/deliveries", "rider"),
    ("GET", f"/api/v1/deliveries/{FAKE_ID}", "rider"),
    ("PATCH", f"/api/v1/deliveries/{FAKE_ID}", "rider"),
    ("DELETE", f"/api/v1/deliveries/{FAKE_ID}", "rider"),
    ("POST", f"/api/v1/deliveries/{FAKE_ID}/arrive", "rider"),
    ("POST", f"/api/v1/deliveries/{FAKE_ID}/proof", "rider"),
    ("POST", f"/api/v1/deliveries/{FAKE_ID}/deliver", "rider"),
    ("POST", f"/api/v1/deliveries/{FAKE_ID}/fail", "rider"),
    ("POST", "/api/v1/routes/build", "rider"),
    ("GET", "/api/v1/routes/current", "rider"),
    ("GET", "/api/v1/routes", "rider"),
    ("GET", f"/api/v1/routes/{FAKE_ID}", "rider"),
    ("POST", f"/api/v1/routes/{FAKE_ID}/start", "rider"),
    ("POST", f"/api/v1/routes/{FAKE_ID}/retry-geocoding", "rider"),
    ("GET", "/api/v1/rider/dashboard", "rider"),
    ("GET", "/api/v1/rider/history", "rider"),
    ("DELETE", "/api/v1/rider/history", "rider"),
    ("GET", "/api/v1/rider/service-area/detect", "rider"),
    ("PUT", "/api/v1/rider/service-area", "rider"),
    ("POST", "/api/v1/reports/generate", "rider"),
    ("GET", "/api/v1/reports", "rider"),
    ("GET", f"/api/v1/reports/{FAKE_ID}", "rider"),
    ("GET", "/api/v1/subscriptions/me", "rider"),
    ("POST", "/api/v1/subscriptions", "rider"),
    ("POST", "/api/v1/subscriptions/cancel", "rider"),
    ("GET", "/api/v1/subscriptions/store", "rider"),
    ("POST", "/api/v1/subscriptions/purchases", "rider"),
    ("POST", "/api/v1/subscriptions/mock/events", "rider"),
    ("GET", "/api/v1/admin/overview", "admin"),
    ("GET", "/api/v1/admin/riders", "admin"),
    ("PATCH", f"/api/v1/admin/riders/{FAKE_ID}", "admin"),
    ("GET", "/api/v1/admin/deliveries", "admin"),
    ("GET", f"/api/v1/admin/deliveries/{FAKE_ID}", "admin"),
    ("GET", "/api/v1/admin/reports", "admin"),
    ("GET", "/api/v1/admin/subscriptions", "admin"),
    ("PATCH", f"/api/v1/admin/subscriptions/{FAKE_ID}", "admin"),
    ("GET", "/api/v1/admin/plans", "admin"),
    ("PATCH", "/api/v1/admin/plans/pro", "admin"),
    ("GET", "/api/v1/admin/payments", "admin"),
    ("POST", "/api/v1/admin/payments", "admin"),
    ("PATCH", f"/api/v1/admin/payments/{FAKE_ID}", "admin"),
    ("GET", "/api/v1/admin/settings", "admin"),
    ("PUT", "/api/v1/admin/settings", "admin"),
    ("GET", "/api/v1/admin/audit-logs", "admin"),
]


@pytest.fixture(autouse=True)
def offline_geocoding():
    """Never call Nominatim from tests."""
    async def geocode(address, area):
        return {"latitude": 31.5, "longitude": 74.3, "normalized": address, "approximate": False}

    async def resolve(point):
        return {"city": "Lahore", "country": "Pakistan", "countryCode": "pk", "latitude": point["latitude"], "longitude": point["longitude"]}
    geocoding_service.set_geocoder_for_tests(geocode)
    geocoding_service.set_area_resolver_for_tests(resolve)
    yield
    geocoding_service.set_geocoder_for_tests()
    geocoding_service.set_area_resolver_for_tests(None)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def forge(claims: dict, secret: str | None = None, alg: str = "HS256") -> str:
    base = {"iss": "delivery-planner", "iat": int(time.time()), "exp": int(time.time()) + 600, "role": "owner_admin"}
    return jwt.encode({**base, **claims}, secret or env.JWT_ACCESS_SECRET, algorithm=alg)


async def call(client, method, path, headers=None):
    return await client.request(method, path, headers=headers or {}, json={} if method in ("POST", "PATCH", "PUT") else None)


async def started_delivery(client, auth, tid):
    d = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery(tid, f"House 1 street for {tid}"))
    did = d.json()["data"]["id"]
    route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": [did]})
    rid = route.json()["data"]["id"]
    await client.post(f"/api/v1/routes/{rid}/start", headers=auth)
    await client.post(f"/api/v1/deliveries/{did}/arrive", headers=auth)
    return did, rid


# ---------------------------------------------------------------- authentication + authorization matrix

async def test_every_protected_endpoint_rejects_missing_and_malformed_tokens(client):
    bad_headers = [{}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"}, {"Authorization": "bearer x.y.z"},
                   {"Authorization": "Bearer not.a.jwt"}]
    for method, path, needs in ENDPOINTS:
        res = await call(client, method, path)
        if needs == "public":
            assert res.status_code == 200, (method, path)
            continue
        for headers in bad_headers:
            res = await call(client, method, path, headers)
            assert res.status_code == 401, (method, path, headers, res.status_code)


async def test_role_matrix_rider_vs_admin(client):
    _, rider_auth = await rider(client, "matrix-rider@example.com")
    admin_auth, _ = await make_admin(client, "matrix-admin@example.com")
    client.cookies.clear()
    for method, path, needs in ENDPOINTS:
        if needs == "admin":
            res = await call(client, method, path, rider_auth)
            assert res.status_code == 403, ("rider reached admin route", method, path, res.status_code)
        if needs == "rider":
            res = await call(client, method, path, admin_auth)
            assert res.status_code == 403, ("admin reached rider route", method, path, res.status_code)


# ---------------------------------------------------------------- JWT tampering

async def test_forged_and_tampered_jwts_are_rejected(client):
    body, auth = await rider(client, "jwt-victim@example.com")
    uid = body["user"]["id"]
    admin_path = "/api/v1/admin/overview"

    cases = {
        "wrong secret": forge({"sub": uid}, secret="x" * 64),
        "alg none": jwt.encode({"sub": uid, "iss": "delivery-planner", "exp": int(time.time()) + 600}, None, algorithm="none"),
        "expired": forge({"sub": uid, "exp": int(time.time()) - 5}),
        "wrong issuer": forge({"sub": uid, "iss": "someone-else"}),
        "no sub": forge({}),
        "non-id sub": forge({"sub": "' OR 1=1 --"}),
        "unknown user": forge({"sub": FAKE_ID}),
        "HS512 with same secret": forge({"sub": uid}, alg="HS512"),
    }
    for name, token in cases.items():
        res = await client.get("/api/v1/auth/me", headers=bearer(token))
        assert res.status_code == 401, (name, res.status_code)

    # Elevating the role claim on a validly-signed token must not grant admin: the role comes from the database.
    elevated = forge({"sub": uid, "role": "owner_admin"})
    res = await client.get(admin_path, headers=bearer(elevated))
    assert res.status_code == 403

    # Flipping one signature character breaks the token.
    token = auth["Authorization"].split(" ")[1]
    head, payload, sig = token.split(".")
    flipped = f"{head}.{payload}.{sig[:-2]}{'A' if sig[-2] != 'A' else 'B'}{sig[-1]}"
    assert (await client.get("/api/v1/auth/me", headers=bearer(flipped))).status_code == 401

    # Swapping the payload for another user's id keeps the old signature, so it fails.
    other, _ = await rider(client, "jwt-other@example.com")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    claims["sub"] = other["user"]["id"]
    swapped_payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    assert (await client.get("/api/v1/auth/me", headers=bearer(f"{head}.{swapped_payload}.{sig}"))).status_code == 401


# ---------------------------------------------------------------- registration / profile mass assignment

async def test_registration_ignores_privileged_fields(client):
    res = await client.post("/api/v1/auth/register", json={
        "fullName": "Sneaky", "phone": "+92 300 0000001", "email": "sneaky@example.com", "password": PASSWORD, "confirmPassword": PASSWORD,
        "currency": "USD", "role": "owner_admin", "status": "active", "id": FAKE_ID, "failedLoginCount": -999,
    })
    assert res.status_code == 201
    user = res.json()["data"]["user"]
    assert user["role"] == "rider" and user["id"] != FAKE_ID
    assert user["phone"] is None  # no longer collected at sign-up: a stale client's phone is dropped
    admin = await client.get("/api/v1/admin/overview", headers=bearer(res.json()["data"]["accessToken"]))
    assert admin.status_code == 403


async def test_profile_patch_cannot_change_role_email_or_status(client):
    body, auth = await rider(client, "patch-self@example.com")
    res = await client.patch("/api/v1/auth/me", headers=auth, json={
        "fullName": "Renamed", "role": "owner_admin", "email": "takeover@example.com", "status": "active", "passwordHash": "x",
    })
    assert res.status_code == 200
    me = res.json()["data"]
    assert me["role"] == "rider" and me["email"] == "patch-self@example.com" and me["fullName"] == "Renamed"
    stored = await db.user.find_unique(where={"id": body["user"]["id"]})
    assert stored.passwordHash.startswith("$2")


async def test_password_rules_and_change_password(client):
    weak = await client.post("/api/v1/auth/register", json={"fullName": "W", "email": "weakpw@example.com",
                                                            "password": "1234567", "confirmPassword": "1234567", "currency": "USD"})
    assert weak.status_code == 400

    body, auth = await rider(client, "changepw@example.com")
    wrong = await client.post("/api/v1/auth/change-password", headers=auth, json={"currentPassword": "nope", "newPassword": "brandnew123"})
    assert wrong.status_code == 422
    other_device = await client.post("/api/v1/auth/login", json={"email": "changepw@example.com", "password": PASSWORD})
    other_auth = bearer(other_device.json()["data"]["accessToken"])
    ok = await client.post("/api/v1/auth/change-password", headers=auth, json={"currentPassword": PASSWORD, "newPassword": "brandnew123"})
    assert ok.status_code == 200
    fresh = ok.json()["data"]
    assert fresh["changed"] is True and fresh["accessToken"] and fresh["refreshToken"]

    # Every access token issued before the change stops working at once, on this device and any other.
    for stale in (auth, other_auth):
        res = await client.get("/api/v1/auth/me", headers=stale)
        assert res.status_code == 401 and res.json()["error"]["code"] == "TOKEN_REVOKED"
    # Old refresh tokens die with the old password; the session that changed it carries on with the new tokens.
    old = await client.post("/api/v1/auth/refresh", json={"refreshToken": body["refreshToken"]})
    assert old.status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=bearer(fresh["accessToken"]))).status_code == 200
    assert (await client.post("/api/v1/auth/refresh", json={"refreshToken": fresh["refreshToken"]})).status_code == 200
    assert (await client.post("/api/v1/auth/login", json={"email": "changepw@example.com", "password": PASSWORD})).status_code == 401
    assert (await client.post("/api/v1/auth/login", json={"email": "changepw@example.com", "password": "brandnew123"})).status_code == 200


async def test_tokens_issued_before_versioning_still_work(client):
    """Tokens minted before this release have no "ver" claim; they must keep working until they expire."""
    body, _ = await rider(client, "legacy-token@example.com")
    legacy = jwt.encode({"sub": body["user"]["id"], "role": "rider", "iss": "delivery-planner", "iat": int(time.time()),
                         "exp": int(time.time()) + 600}, env.JWT_ACCESS_SECRET, algorithm="HS256")
    assert (await client.get("/api/v1/auth/me", headers=bearer(legacy))).status_code == 200


# ---------------------------------------------------------------- login hardening

async def test_login_errors_do_not_reveal_which_part_was_wrong(client):
    await rider(client, "enum@example.com")
    missing = await client.post("/api/v1/auth/login", json={"email": "nobody-here@example.com", "password": "whatever123"})
    wrong = await client.post("/api/v1/auth/login", json={"email": "enum@example.com", "password": "whatever123"})
    assert missing.status_code == wrong.status_code == 401
    assert missing.json()["error"] == wrong.json()["error"]


async def test_login_timing_does_not_reveal_registered_emails(client):
    """A missing account must cost about as much bcrypt work as a real one."""
    await rider(client, "timing@example.com")

    async def avg(email):
        samples = []
        for _ in range(3):
            t = time.perf_counter()
            await client.post("/api/v1/auth/login", json={"email": email, "password": "wrong-password-1"})
            samples.append(time.perf_counter() - t)
        return sorted(samples)[1]

    await db.user.update_many(where={"email": "timing@example.com"}, data={"failedLoginCount": -1000})
    real, missing = await avg("timing@example.com"), await avg("ghost-timing@example.com")
    assert missing > real * 0.5, f"missing account answered in {missing * 1000:.0f}ms vs {real * 1000:.0f}ms for a real one"


async def test_lockout_after_failed_logins_and_suspended_accounts(client):
    await rider(client, "lockme@example.com")
    for _ in range(5):
        await client.post("/api/v1/auth/login", json={"email": "lockme@example.com", "password": "bad-password"})
    locked = await client.post("/api/v1/auth/login", json={"email": "lockme@example.com", "password": PASSWORD})
    assert locked.status_code == 429 and locked.json()["error"]["code"] == "ACCOUNT_LOCKED"


async def test_lockout_state_does_not_reveal_registered_emails(client):
    """After N bad passwords a real account says ACCOUNT_LOCKED while an unknown email keeps saying INVALID_CREDENTIALS."""
    await rider(client, "lock-enum@example.com")
    for email in ("lock-enum@example.com", "lock-enum-ghost@example.com"):
        for _ in range(5):
            await client.post("/api/v1/auth/login", json={"email": email, "password": "bad-password"})
    real = await client.post("/api/v1/auth/login", json={"email": "lock-enum@example.com", "password": "bad-password"})
    ghost = await client.post("/api/v1/auth/login", json={"email": "lock-enum-ghost@example.com", "password": "bad-password"})
    assert real.json()["error"]["code"] == ghost.json()["error"]["code"], (real.json()["error"]["code"], ghost.json()["error"]["code"])


async def test_parallel_wrong_passwords_cannot_skip_the_lockout(client):
    """The failed-login counter is read-then-written; concurrent guesses can overwrite each other's increments."""
    await rider(client, "race-lock@example.com")
    results = await asyncio.gather(*(client.post("/api/v1/auth/login", json={"email": "race-lock@example.com", "password": f"guess-{i}"})
                                     for i in range(15)))
    codes = [r.json()["error"]["code"] for r in results]
    assert codes.count("INVALID_CREDENTIALS") <= 5, f"{codes.count('INVALID_CREDENTIALS')} password guesses were checked before lockout (limit 5)"


async def test_admin_cannot_log_into_mobile_and_rider_cannot_log_into_web(client):
    await make_admin(client, "wrong-client-admin@example.com")
    client.cookies.clear()
    await rider(client, "wrong-client-rider@example.com")
    a = await client.post("/api/v1/auth/login", json={"email": "wrong-client-admin@example.com", "password": PASSWORD, "client": "mobile"})
    r = await client.post("/api/v1/auth/login", json={"email": "wrong-client-rider@example.com", "password": PASSWORD, "client": "web"})
    assert a.status_code == r.status_code == 403
    assert "set-cookie" not in r.headers


async def test_suspension_kills_access_and_refresh_immediately(client):
    body, auth = await rider(client, "suspend-me@example.com")
    admin_auth, _ = await make_admin(client, "suspender@example.com")
    client.cookies.clear()
    res = await client.patch(f"/api/v1/admin/riders/{body['user']['id']}", headers=admin_auth, json={"status": "suspended"})
    assert res.status_code == 200
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 403
    assert (await client.post("/api/v1/auth/refresh", json={"refreshToken": body["refreshToken"]})).status_code in (401, 403)
    assert (await client.post("/api/v1/auth/login", json={"email": "suspend-me@example.com", "password": PASSWORD})).status_code == 403
    # Admins cannot be suspended through the rider endpoint.
    admin_row = await db.user.find_first(where={"email": "suspender@example.com"})
    assert (await client.patch(f"/api/v1/admin/riders/{admin_row.id}", headers=admin_auth, json={"status": "suspended"})).status_code == 404


async def test_cached_account_skips_lookups_but_changes_apply_at_once(client, monkeypatch):
    from app import auth as auth_module

    body, auth = await rider(client, "cached-account@example.com")
    admin_auth, _ = await make_admin(client, "cache-admin@example.com")
    client.cookies.clear()
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 200

    lookups = []
    actions = type(auth_module.db.user)
    find_unique = actions.find_unique

    async def counting_find_unique(self, *args, **kwargs):
        lookups.append(kwargs.get("where"))
        return await find_unique(self, *args, **kwargs)

    monkeypatch.setattr(actions, "find_unique", counting_find_unique)
    for _ in range(3):
        assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 200
    # Only /auth/me's own profile read is left: authenticate() answered from the cache (it was 2 lookups per request).
    assert len([w for w in lookups if w == {"id": body["user"]["id"]}]) == 3

    # A password change revokes old tokens straight away, even though the account was cached.
    changed = await client.post("/api/v1/auth/change-password", headers=auth,
                                json={"currentPassword": PASSWORD, "newPassword": PASSWORD + "x", "confirmPassword": PASSWORD + "x"})
    assert changed.status_code == 200, changed.text
    assert (await client.get("/api/v1/auth/me", headers=auth)).json()["error"]["code"] == "TOKEN_REVOKED"
    fresh = {"Authorization": f"Bearer {changed.json()['data']['accessToken']}"}
    assert (await client.get("/api/v1/auth/me", headers=fresh)).status_code == 200

    # So does a suspension.
    assert (await client.patch(f"/api/v1/admin/riders/{body['user']['id']}", headers=admin_auth, json={"status": "suspended"})).status_code == 200
    assert (await client.get("/api/v1/auth/me", headers=fresh)).status_code == 403


# ---------------------------------------------------------------- refresh tokens / cookies / CSRF

async def test_refresh_token_edge_cases(client):
    body, _ = await rider(client, "refresh-edge@example.com")
    for token in ("x" * 20, "", None, body["refreshToken"] + "x"):
        res = await client.post("/api/v1/auth/refresh", json={"refreshToken": token} if token is not None else {})
        assert res.status_code in (400, 401), (token, res.status_code)

    # Two parallel refreshes with the same token: at most one wins.
    results = await asyncio.gather(*(client.post("/api/v1/auth/refresh", json={"refreshToken": body["refreshToken"]}) for _ in range(5)))
    assert sum(r.status_code == 200 for r in results) <= 1

    # Logout revokes the whole family.
    fresh, _ = await rider(client, "refresh-logout@example.com")
    await client.post("/api/v1/auth/logout", json={"refreshToken": fresh["refreshToken"]})
    assert (await client.post("/api/v1/auth/refresh", json={"refreshToken": fresh["refreshToken"]})).status_code == 401


async def test_admin_cookie_flags_and_csrf_on_logout(client):
    _, login = await make_admin(client, "cookie-flags@example.com")
    cookie = login.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api/v1/auth" in cookie
    blocked = await client.post("/api/v1/auth/logout", json={"client": "web"})
    assert blocked.json()["error"]["code"] == "CSRF_BLOCKED"
    client.cookies.clear()


# ---------------------------------------------------------------- cross-rider isolation (IDOR)

async def test_rider_cannot_touch_another_riders_deliveries_routes_or_reports(client):
    _, alice = await rider(client, "idor-alice@example.com")
    _, bob = await rider(client, "idor-bob@example.com")

    pending = (await client.post("/api/v1/deliveries/manual", headers=alice, json=delivery("IDOR-P1", "Alice street 12"))).json()["data"]["id"]
    active_id, route_id = await started_delivery(client, alice, "IDOR-A1")
    await client.post(f"/api/v1/deliveries/{active_id}/proof", headers=alice, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    await client.post(f"/api/v1/deliveries/{active_id}/deliver", headers=alice, json={})
    report = await client.post("/api/v1/reports/generate", headers=alice, json={})
    assert report.status_code == 201
    report_id = report.json()["data"]["id"]

    attempts = [
        ("GET", f"/api/v1/deliveries/{pending}", None), ("PATCH", f"/api/v1/deliveries/{pending}", {"note": "pwned"}),
        ("DELETE", f"/api/v1/deliveries/{pending}", None), ("POST", f"/api/v1/deliveries/{pending}/arrive", None),
        ("POST", f"/api/v1/deliveries/{active_id}/deliver", {}), ("POST", f"/api/v1/deliveries/{active_id}/fail", {"reason": "wrong_address"}),
        ("GET", f"/api/v1/routes/{route_id}", None), ("POST", f"/api/v1/routes/{route_id}/start", None),
        ("POST", f"/api/v1/routes/{route_id}/retry-geocoding", None), ("GET", f"/api/v1/reports/{report_id}", None),
    ]
    for method, path, payload in attempts:
        res = await client.request(method, path, headers=bob, json=payload)
        assert res.status_code == 404, (method, path, res.status_code)
    proof = await client.post(f"/api/v1/deliveries/{pending}/proof", headers=bob, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    assert proof.status_code == 404

    # Bob's lists, dashboard, history and bulk deletes never include or affect Alice's data.
    assert (await client.get("/api/v1/deliveries", headers=bob)).json()["meta"]["total"] == 0
    assert (await client.get("/api/v1/reports", headers=bob)).json()["data"] == []
    assert (await client.get("/api/v1/rider/history", headers=bob)).json()["data"] == []
    assert (await client.get("/api/v1/routes/current", headers=bob)).json()["data"] is None
    await client.delete("/api/v1/deliveries", headers=bob)
    await client.delete("/api/v1/rider/history", headers=bob)
    assert (await client.get(f"/api/v1/deliveries/{pending}", headers=alice)).status_code == 200
    assert (await client.get(f"/api/v1/reports/{report_id}", headers=alice)).status_code == 200

    # Building a route with Alice's delivery ids must not pull them into Bob's route.
    built = await client.post("/api/v1/routes/build", headers=bob, json={"deliveryIds": [pending]})
    assert built.status_code in (201, 409, 422)
    alice_pending = await db.delivery.find_unique(where={"id": pending})
    assert alice_pending.routeId is None and alice_pending.riderId != (await db.user.find_first(where={"email": "idor-bob@example.com"})).id


# ---------------------------------------------------------------- signed file URLs

async def test_signed_file_urls_cannot_be_forged_extended_or_traversed(client):
    _, auth = await rider(client, "files@example.com")
    did, _ = await started_delivery(client, auth, "FILE-1")
    up = await client.post(f"/api/v1/deliveries/{did}/proof", headers=auth, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    url = up.json()["data"]["proof"]["photoUrl"]
    path, qs = url.split("?")
    params = dict(p.split("=", 1) for p in qs.split("&"))
    assert (await client.get(url)).status_code == 200

    tampered = [
        f"{path}?exp={int(params['exp']) + 10_000}&d=inline&sig={params['sig']}",          # extend expiry
        f"{path}?exp={params['exp']}&d=attachment&sig={params['sig']}",                    # flip disposition
        f"{path}?exp={params['exp']}&d=inline",                                            # drop signature
        f"{path}?exp={params['exp']}&d=inline&sig=",                                       # empty signature
        f"{path}?exp=99999999999&d=inline&sig={params['sig']}",
        f"{path}?exp=1e20&d=inline&sig={params['sig']}",
        f"{path}?exp=nan&d=inline&sig={params['sig']}",
        f"{path}?exp=inf&d=inline&sig={params['sig']}",
        path,
    ]
    for u in tampered:
        assert (await client.get(u)).status_code == 404, u

    # A valid signature for one file never opens another.
    other_key = path.replace("/api/v1/files/", "").rsplit("/", 1)[0] + "/00000000-0000-0000-0000-000000000000.jpg"
    assert (await client.get(f"/api/v1/files/{other_key}?{qs}")).status_code == 404

    # Path traversal with a correctly signed key still cannot leave the storage folder.
    for key in ("../.env", "proofs/../../.env", "proofs/..%2f..%2f.env", "proofs/%2e%2e%2f%2e%2e%2fapp%2fconfig.py", "reports/..\\..\\.env"):
        exp = int(time.time()) + 600
        sig = base64.urlsafe_b64encode(hmac.new(env.FILE_SIGNING_SECRET.encode(), f"{key}.{exp}.inline".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        res = await client.get(f"/api/v1/files/{key}?exp={exp}&d=inline&sig={sig}")
        assert res.status_code == 404 and b"JWT" not in res.content, key

    # Expired links stop working.
    from app.security import sign_file_url
    expired = sign_file_url(path.replace("/api/v1/files/", ""), ttl=-10)
    assert (await client.get(expired)).status_code == 404


# ---------------------------------------------------------------- uploads

async def test_upload_validation_rejects_disguised_and_oversized_files(client):
    _, auth = await rider(client, "uploads@example.com")
    did, _ = await started_delivery(client, auth, "UP-1")
    proof = f"/api/v1/deliveries/{did}/proof"

    cases = [
        ({"photo": ("x.jpg", b"<?php system($_GET['c']); ?>", "image/jpeg")}, 415),         # script with jpg name
        ({"photo": ("x.html", b"<script>alert(1)</script>", "text/html")}, 415),
        ({"photo": ("x.svg", b"<svg onload=alert(1)>", "image/svg+xml")}, 415),
        ({"photo": ("x.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, "text/html")}, 200),      # real magic bytes win, stored as .png
        ({"evil": ("x.jpg", JPEG, "image/jpeg")}, 400),                                      # unexpected field
        ({"photo": ("x.jpg", b"\xff\xd8\xff" + b"\x00" * (8 * 1024 * 1024), "image/jpeg")}, 413),
    ]
    for files, expected in cases:
        res = await client.post(proof, headers=auth, files=files)
        assert res.status_code == expected, (next(iter(files.values()))[0], res.status_code, res.text[:200])
    two = await client.post(proof, headers=auth, files=[("photo", ("a.jpg", JPEG, "image/jpeg")), ("photo", ("b.jpg", JPEG, "image/jpeg"))])
    assert two.status_code == 400
    none = await client.post(proof, headers=auth)
    assert none.status_code == 422

    # Stored file names are random: the client's filename never reaches the disk.
    ok = await client.post(proof, headers=auth, files={"photo": ("../../../evil.jpg", JPEG, "image/jpeg")})
    assert ok.status_code == 200
    assert "evil" not in ok.json()["data"]["proof"]["photoUrl"]

    # Document import: extension/magic mismatches are refused.
    imp = "/api/v1/deliveries/import/file"
    for name, data in [("x.pdf", b"not a pdf"), ("x.docx", b"not a zip"), ("x.exe", b"MZ"), ("x.xls", b"PK..")]:
        res = await client.post(imp, headers=auth, files={"file": (name, data, "application/octet-stream")})
        assert res.status_code in (415, 422), (name, res.status_code)


async def test_malformed_office_and_pdf_files_fail_cleanly(client):
    _, auth = await rider(client, "badfiles@example.com")
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as z:
        z.writestr("[Content_Types].xml", "<garbage")
    xxe = (b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>')
    xxe_zip = io.BytesIO()
    with zipfile.ZipFile(xxe_zip, "w") as z:
        z.writestr("[Content_Types].xml", xxe)
        z.writestr("word/document.xml", xxe)
    for name, data in [("x.docx", zip_buf.getvalue()), ("x.xlsx", zip_buf.getvalue()), ("x.docx", xxe_zip.getvalue()),
                       ("x.pdf", b"%PDF-1.7\n" + b"\x00" * 200), ("x.csv", b"\x00\xff\xfe" * 100)]:
        res = await client.post("/api/v1/deliveries/import/file", headers=auth, files={"file": (name, data, "application/octet-stream")})
        assert res.status_code in (415, 422), (name, res.status_code, res.text[:200])
        assert "root:" not in res.text


# ---------------------------------------------------------------- input handling

async def test_injection_strings_are_treated_as_data(client):
    _, auth = await rider(client, "inject@example.com")
    admin_auth, _ = await make_admin(client, "inject-admin@example.com")
    client.cookies.clear()
    payloads = ["' OR 1=1 --", "\"; DROP TABLE \"User\"; --", "%", "_", "\\", "{\"$ne\": null}", "<script>alert(1)</script>", "\u0000"]
    for p in payloads:
        for path, headers in [("/api/v1/deliveries", auth), ("/api/v1/admin/riders", admin_auth), ("/api/v1/admin/deliveries", admin_auth),
                              ("/api/v1/admin/reports", admin_auth), ("/api/v1/admin/subscriptions", admin_auth),
                              ("/api/v1/admin/payments", admin_auth), ("/api/v1/admin/audit-logs", admin_auth)]:
            res = await client.get(path, headers=headers, params={"search": p})
            assert res.status_code in (200, 400), (path, p, res.status_code)
            if res.status_code == 200 and path == "/api/v1/admin/riders":
                assert all("inject" not in r["email"] or p in r["email"] for r in res.json()["data"]) or p in ("%", "_", "\\")

    # Stored XSS-looking text is stored verbatim and returned as JSON (escaping is the client's job), never executed server side.
    xss = "<img src=x onerror=alert(1)>"
    res = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("XSS-1", f"{xss} street", note=xss))
    assert res.status_code == 201
    assert res.headers["content-type"].startswith("application/json")


async def test_search_wildcards_do_not_match_everything(client):
    _, auth = await rider(client, "wild@example.com")
    await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("WILD-1", "Some street 1"))
    for p in ("%", "_"):
        res = await client.get("/api/v1/deliveries", headers=auth, params={"search": p})
        assert res.json()["meta"]["total"] == 0, f"search={p!r} matched {res.json()['meta']['total']} rows"


async def test_odd_bodies_and_query_values_never_cause_500s(client):
    _, auth = await rider(client, "fuzz@example.com")
    admin_auth, _ = await make_admin(client, "fuzz-admin@example.com")
    client.cookies.clear()
    bodies = [b"[]", b"null", b"123", b'"str"', b"{\"a\":" * 5000 + b"1" + b"}" * 5000, b"\xff\xfe", b"{}" * 10]
    for raw in bodies:
        for path in ("/api/v1/auth/login", "/api/v1/deliveries/manual", "/api/v1/routes/build"):
            res = await client.post(path, content=raw, headers={**auth, "Content-Type": "application/json"})
            assert res.status_code < 500, (path, raw[:20], res.status_code)

    queries = [{"page": "99999999999999999999"}, {"page": "0"}, {"limit": "1000"}, {"page": "-1"}, {"page": "1e3"}, {"date": "2026-02-30"},
               {"dateFrom": "9999-12-31", "dateTo": "0001-01-01"}, {"status": ["pending", "failed"]}, {"page": "9223372036854775807"},
               {"page": "92233720368547758"}]
    for q in queries:
        for path, headers in (("/api/v1/deliveries", auth), ("/api/v1/admin/riders", admin_auth), ("/api/v1/admin/audit-logs", admin_auth)):
            res = await client.get(path, headers=headers, params=q)
            assert res.status_code < 500, (path, q, res.status_code, res.text[:200])

    huge = await client.post("/api/v1/auth/login", content=b'{"email":"' + b"a" * (1024 * 1024 + 10) + b'"}', headers={"Content-Type": "application/json"})
    assert huge.status_code == 413

    bounds = [{"latitude": 91, "longitude": 0}, {"latitude": "NaN", "longitude": 0}, {"latitude": "inf", "longitude": 0}]
    for q in bounds:
        res = await client.get("/api/v1/rider/service-area/detect", headers=auth, params=q)
        assert res.status_code == 400, (q, res.status_code)
    nan_origin = await client.post("/api/v1/routes/build", headers={**auth, "Content-Type": "application/json"},
                                   content=b'{"origin":{"latitude":NaN,"longitude":0}}')
    assert nan_origin.status_code == 400


async def test_oversized_bodies_are_refused_before_being_buffered(client):
    _, auth = await rider(client, "body-limit@example.com")
    read = 0

    async def endless():
        nonlocal read
        for _ in range(64):  # 64 MB if fully consumed
            read += 1
            yield b"a" * (1024 * 1024)

    # Chunked body with no Content-Length: the server must stop reading once it passes the limit.
    res = await client.post("/api/v1/auth/logout", content=endless(), headers={"Content-Type": "application/json"})
    assert res.status_code == 413 and read <= 3, (res.status_code, read)

    # A declared Content-Length over the limit is refused without reading anything.
    res = await client.post("/api/v1/auth/logout", content=b"{}", headers={"Content-Type": "application/json", "Content-Length": str(50 * 1024 * 1024)})
    assert res.status_code == 413

    # Upload routes allow 10 MB files but not much more.
    big = b"%PDF-" + b"0" * (12 * 1024 * 1024)
    res = await client.post("/api/v1/deliveries/import/pdf", headers=auth, files={"file": ("a.pdf", big, "application/pdf")})
    assert res.status_code == 413


async def test_request_id_header_cannot_inject(client):
    res = await client.get("/health", headers={"X-Request-Id": "abc\r\nSet-Cookie: x=1"})
    assert "set-cookie" not in res.headers and res.headers["x-request-id"] != "abc"
    res = await client.get("/health", headers={"X-Request-Id": "valid-request-id-123"})
    assert res.headers["x-request-id"] == "valid-request-id-123"


# ---------------------------------------------------------------- business-logic abuse

async def test_rider_cannot_activate_a_paid_plan_without_admin_payment(client):
    _, auth = await rider(client, "freeloader@example.com")
    req = await client.post("/api/v1/subscriptions", headers=auth, json={"planKey": "pro", "billingCycle": "annual"})
    assert req.status_code == 201
    assert req.json()["data"]["payment"]["status"] == "pending"
    sub = (await client.get("/api/v1/subscriptions/me", headers=auth)).json()["data"]
    assert sub["subscription"]["planKey"] == "trial" and sub["subscription"]["status"] == "trialing"
    for extra in ({"planKey": "trial", "billingCycle": "monthly"}, {"planKey": "pro", "billingCycle": "annual", "amount": 0, "status": "succeeded"}):
        res = await client.post("/api/v1/subscriptions", headers=auth, json=extra)
        if res.status_code == 201:
            assert res.json()["data"]["payment"]["status"] == "pending"
            assert res.json()["data"]["payment"]["amount"] > 0
        else:
            assert res.status_code == 400


async def test_payment_state_machine_cannot_be_reversed(client):
    body, _ = await rider(client, "payer@example.com")
    admin_auth, _ = await make_admin(client, "payments-admin@example.com")
    client.cookies.clear()
    paid = await client.post("/api/v1/admin/payments", headers=admin_auth, json={"riderId": body["user"]["id"], "planKey": "pro", "billingCycle": "monthly"})
    assert paid.status_code == 201
    pid = paid.json()["data"]["id"]
    assert (await client.patch(f"/api/v1/admin/payments/{pid}", headers=admin_auth, json={"status": "failed"})).status_code == 409
    assert (await client.patch(f"/api/v1/admin/payments/{pid}", headers=admin_auth, json={"status": "pending"})).status_code == 400
    neg = await client.post("/api/v1/admin/payments", headers=admin_auth, json={"riderId": body["user"]["id"], "planKey": "pro",
                                                                                 "billingCycle": "monthly", "amount": -5})
    assert neg.status_code == 400


async def test_parallel_bulk_creates_cannot_exceed_the_plan_limit(client):
    _, auth = await rider(client, "limit-race@example.com")
    trial = await db.plan.find_unique(where={"key": "trial"})
    limit = trial.deliveriesPerMonth
    per_call = max(1, limit // 2 + 1)  # any two successful calls would exceed the limit

    def batch(n):
        return {"items": [delivery(f"RACE-{n}-{i}", f"Race street {n} {i}") for i in range(min(per_call, 300))]}
    if per_call > 300:
        pytest.skip(f"trial limit {limit} is above the bulk size; race not reachable in one request pair")
    results = await asyncio.gather(*(client.post("/api/v1/deliveries/bulk", headers=auth, json=batch(n)) for n in range(4)))
    created = await db.delivery.count(where={"rider": {"is": {"email": "limit-race@example.com"}}})
    assert created <= limit, f"{created} deliveries created on a {limit}/month plan ({[r.status_code for r in results]})"


async def test_clearing_history_also_deletes_proof_photos(client):
    """'Permanently removes completed rider work': customer doorstep photos should not survive on disk."""
    from app.services import storage_service as storage

    _, auth = await rider(client, "privacy@example.com")
    did, _ = await started_delivery(client, auth, "PRIV-1")
    up = await client.post(f"/api/v1/deliveries/{did}/proof", headers=auth, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    key = (await db.delivery.find_unique(where={"id": did})).proofPhotoKey
    assert up.status_code == 200 and key
    await client.post(f"/api/v1/deliveries/{did}/deliver", headers=auth, json={})
    cleared = await client.delete("/api/v1/rider/history", headers=auth)
    assert cleared.json()["data"]["deliveriesDeleted"] == 1
    assert not storage.resolve_key(key).exists(), f"proof photo {key} is still on disk after the rider cleared history"


async def test_admin_settings_reject_unsafe_values(client):
    admin_auth, _ = await make_admin(client, "settings-admin@example.com")
    client.cookies.clear()
    for body in ({"platform": {"privacyUrl": "javascript:alert(1)"}}, {"platform": {"privacyUrl": "data:text/html,x"}},
                 {"security": {"minPasswordLength": 1}}, {"security": {"maxFailedLogins": 1000}}, {"currencies": []}, {"trialDays": -1}):
        res = await client.put("/api/v1/admin/settings", headers=admin_auth, json=body)
        assert res.status_code == 400, (body, res.status_code)
    public = (await client.get("/api/v1/config")).json()["data"]
    assert not {"security", "maxFailedLogins", "lockoutMinutes"} & set(public)


# ---------------------------------------------------------------- admin endpoints: happy path smoke

async def test_every_admin_endpoint_works_for_an_admin(client):
    body, auth = await rider(client, "admin-smoke-rider@example.com")
    admin_auth, _ = await make_admin(client, "admin-smoke@example.com")
    client.cookies.clear()
    did = (await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("ADM-1", "Admin smoke street"))).json()["data"]["id"]
    rid = body["user"]["id"]
    sub_id = (await db.subscription.find_unique(where={"userId": rid})).id

    checks = [
        ("GET", "/api/v1/admin/overview?days=30", None, 200), ("GET", "/api/v1/admin/riders?search=smoke", None, 200),
        ("GET", "/api/v1/admin/deliveries", None, 200), ("GET", f"/api/v1/admin/deliveries/{did}", None, 200),
        ("GET", "/api/v1/admin/reports", None, 200), ("GET", "/api/v1/admin/subscriptions?status=trialing", None, 200),
        ("PATCH", f"/api/v1/admin/subscriptions/{sub_id}", {"extendDays": 3}, 200), ("GET", "/api/v1/admin/plans", None, 200),
        ("PATCH", "/api/v1/admin/plans/starter", {"features": ["A"]}, 200), ("GET", "/api/v1/admin/payments", None, 200),
        ("GET", "/api/v1/admin/settings", None, 200), ("PUT", "/api/v1/admin/settings", {"trialDays": 14}, 200),
        ("GET", "/api/v1/admin/audit-logs", None, 200), ("PATCH", f"/api/v1/admin/riders/{rid}", {"status": "active"}, 200),
    ]
    for method, path, payload, expected in checks:
        res = await client.request(method, path, headers=admin_auth, json=payload)
        assert res.status_code == expected, (method, path, res.status_code, res.text[:200])
        assert "passwordHash" not in res.text and "tokenHash" not in res.text
    logs = (await client.get("/api/v1/admin/audit-logs", params={"limit": 100}, headers=admin_auth)).json()["data"]
    assert {"settings.update", "plan.update", "subscription.update", "rider.update"} <= {log["action"] for log in logs}


async def test_rider_endpoints_happy_path_smoke(client):
    _, auth = await rider(client, "rider-smoke@example.com")
    did, rid = await started_delivery(client, auth, "SMOKE-1")
    checks = [
        ("GET", "/api/v1/auth/me", None, 200), ("PATCH", "/api/v1/auth/me", {"notificationsEnabled": False}, 200),
        ("GET", "/api/v1/deliveries?sort=route", None, 200), ("GET", f"/api/v1/deliveries/{did}", None, 200),
        ("GET", "/api/v1/routes/current", None, 200), ("GET", f"/api/v1/routes/{rid}", None, 200),
        ("POST", f"/api/v1/routes/{rid}/retry-geocoding", None, 200), ("POST", f"/api/v1/deliveries/{did}/fail", {"reason": "customer_refused"}, 200),
        ("GET", "/api/v1/routes", None, 200), ("GET", "/api/v1/rider/dashboard", None, 200), ("GET", "/api/v1/rider/history", None, 200),
        ("GET", "/api/v1/rider/service-area/detect?latitude=31.5&longitude=74.3", None, 200),
        ("PUT", "/api/v1/rider/service-area", {"latitude": 31.5, "longitude": 74.3}, 200),
        ("POST", "/api/v1/reports/generate", {}, 201), ("GET", "/api/v1/reports", None, 200),
        ("GET", "/api/v1/subscriptions/me", None, 200), ("POST", "/api/v1/subscriptions", {"planKey": "starter", "billingCycle": "monthly"}, 201),
        ("POST", "/api/v1/subscriptions/cancel", None, 409),  # still on trial
        ("DELETE", "/api/v1/deliveries", None, 200), ("DELETE", "/api/v1/rider/history", None, 200),
    ]
    for method, path, payload, expected in checks:
        res = await client.request(method, path, headers=auth, json=payload)
        assert res.status_code == expected, (method, path, res.status_code, res.text[:200])
        assert "passwordHash" not in res.text and "tokenHash" not in res.text


# ---------------------------------------------------------------- transport headers / CORS / info leaks

async def test_large_json_is_gzipped_small_and_identity_requests_are_not(client):
    _, auth = await rider(client, "gzip@example.com")
    items = [delivery(f"GZ-{i}", f"{i} Long Enough Street, Somewhere real enough") for i in range(8)]
    assert (await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": items})).status_code == 201

    zipped = await client.get("/api/v1/deliveries", headers={**auth, "Accept-Encoding": "gzip"})
    assert zipped.headers.get("content-encoding") == "gzip" and zipped.json()["success"] is True
    plain = await client.get("/api/v1/deliveries", headers={**auth, "Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.json() == zipped.json()
    assert "content-encoding" not in (await client.get("/health", headers={"Accept-Encoding": "gzip"})).headers


async def test_security_headers_cors_and_no_debug_leaks(client):
    res = await client.get("/health")
    for header in ("content-security-policy", "x-content-type-options", "x-frame-options", "strict-transport-security", "referrer-policy"):
        assert header in res.headers, header
    assert "server" not in res.headers or "uvicorn" not in res.headers.get("server", "").lower()

    evil = await client.options("/api/v1/auth/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert evil.headers.get("access-control-allow-origin") not in ("*", "https://evil.example")
    good_origin = env.cors_origins[0]
    good = await client.options("/api/v1/auth/login", headers={"Origin": good_origin, "Access-Control-Request-Method": "POST"})
    assert good.headers.get("access-control-allow-origin") == good_origin

    # Unknown routes and methods give a generic 404, never a stack trace.
    for method, path in (("GET", "/api/v1/../../etc/passwd"), ("TRACE", "/api/v1/auth/me"), ("GET", "/api/v1/admin")):
        r = await client.request(method, path)
        assert r.status_code in (404, 405) and "Traceback" not in r.text


# ---------------------------------------------------------------- shared rate limits

async def test_rate_limits_are_shared_across_workers_and_atomic(client):
    """Two limiter objects with the same name stand in for two API worker processes: they share one count."""
    from app.middleware import RateLimiter

    worker_a = RateLimiter("shared-test", 60, 3, enforce=True)
    worker_b = RateLimiter("shared-test", 60, 3, enforce=True)
    try:
        await worker_a.check("203.0.113.7")
        await worker_b.check("203.0.113.7")
        await worker_a.check("203.0.113.7")
        with pytest.raises(Exception) as blocked:
            await worker_b.check("203.0.113.7")
        assert getattr(blocked.value, "code", None) == "RATE_LIMITED"
        assert await worker_a.exceeded("203.0.113.7")
        # Other clients keep their own budget.
        assert "r=2;" in (await worker_a.check("203.0.113.8"))["RateLimit"]

        # Parallel hits never let more than the limit through.
        results = await asyncio.gather(*(worker_a.check("203.0.113.9") for _ in range(10)), return_exceptions=True)
        assert sum(not isinstance(r, Exception) for r in results) == 3
    finally:
        await db.ratelimit.delete_many(where={"key": {"startswith": "shared-test:"}})


async def test_general_limits_count_in_memory_without_db_writes(client):
    from app.middleware import RateLimiter, api_limiter, auth_limiter, memory_windows, upload_limiter

    assert api_limiter.store == "memory"
    assert auth_limiter.store == "db" and upload_limiter.store == "db"
    limiter = RateLimiter("memory-test", 60, 3, enforce=True, store="memory")
    try:
        for remaining in (2, 1, 0):
            assert f"r={remaining};" in (await limiter.check("203.0.113.10"))["RateLimit"]
        with pytest.raises(Exception) as blocked:
            await limiter.check("203.0.113.10")
        assert getattr(blocked.value, "code", None) == "RATE_LIMITED"
        assert await limiter.exceeded("203.0.113.10") and not await limiter.exceeded("203.0.113.11")
        assert not await db.ratelimit.find_first(where={"key": {"startswith": "memory-test:"}})
    finally:
        memory_windows.clear()


async def test_registration_cannot_be_used_to_enumerate_accounts_at_scale(client):
    from app.middleware import email_taken_limiter

    await rider(client, "taken-1@example.com")
    email_taken_limiter.enforce = True
    try:
        for _ in range(email_taken_limiter.limit):
            res = await client.post("/api/v1/auth/register", json={"fullName": "Probe", "email": "taken-1@example.com",
                                                                   "password": PASSWORD, "confirmPassword": PASSWORD, "currency": "USD"})
            assert res.json()["error"]["code"] == "EMAIL_TAKEN"
        # Over the cap, the answer is the same whether the email is taken or free, so it reveals nothing.
        for email in ("taken-1@example.com", "free-after-cap@example.com"):
            res = await client.post("/api/v1/auth/register", json={"fullName": "Probe", "email": email,
                                                                   "password": PASSWORD, "confirmPassword": PASSWORD, "currency": "USD"})
            assert res.status_code == 429, (email, res.status_code)
        assert not await db.user.find_unique(where={"email": "free-after-cap@example.com"})
    finally:
        email_taken_limiter.enforce = None
        await db.ratelimit.delete_many(where={"key": {"startswith": "email-taken:"}})


async def test_unknown_email_lockout_is_stored_for_every_worker(client):
    for _ in range(5):
        await client.post("/api/v1/auth/login", json={"email": "ghost-shared@example.com", "password": "bad-password"})
    row = await db.ratelimit.find_unique(where={"key": "login-unknown:ghost-shared@example.com"})
    assert row and row.count == 5 and row.lockedUntil is not None
    res = await client.post("/api/v1/auth/login", json={"email": "ghost-shared@example.com", "password": "bad-password"})
    assert res.json()["error"]["code"] == "ACCOUNT_LOCKED"


async def test_parallel_report_generation_cannot_exceed_the_plan_limit(client):
    _, auth = await rider(client, "report-race@example.com")
    dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"]
    await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": [delivery(f"RR-{d}", f"Report race street {d}", serviceDate=d) for d in dates]})
    trial = await db.plan.find_unique(where={"key": "trial"})
    await db.plan.update(where={"key": "trial"}, data={"reportsPerMonth": 1})
    try:
        results = await asyncio.gather(*(client.post("/api/v1/reports/generate", headers=auth, json={"date": d}) for d in dates))
        codes = sorted(r.status_code for r in results)
        assert codes == [201, 403, 403, 403], codes
        assert len((await client.get("/api/v1/reports", headers=auth)).json()["data"]) == 1
        # Losing requests clean up the PDF they rendered.
        from app.services import storage_service as storage
        on_disk = list((storage.root() / "reports").glob("*.pdf"))
        keys = {r.fileKey for r in await db.report.find_many()}
        assert {f"reports/{f.name}" for f in on_disk} <= keys
    finally:
        await db.plan.update(where={"key": "trial"}, data={"reportsPerMonth": trial.reportsPerMonth})


# ---------------------------------------------------------------- API docs

async def test_openapi_documents_every_body_parameter_and_lock(client):
    import fastapi.routing as fr

    from app.main import create_app
    from app.openapi import _handler_calls

    app = create_app(run_jobs=False)
    spec = app.openapi()
    public = {"/health", "/ready", "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout",
              "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password/verify", "/api/v1/auth/reset-password",
              "/api/v1/billing/webhooks/apple", "/api/v1/billing/webhooks/google", "/api/v1/billing/webhooks/revenuecat",
              "/api/v1/config", "/api/v1/files/{kind}/{name}"}
    for route in fr.iter_route_contexts(app.routes):
        if not isinstance(route.original_route, fr.APIRoute):
            continue
        calls = _handler_calls(route.endpoint)
        for method in route.methods:
            op = spec["paths"][route.path_format][method.lower()]
            where = f"{method} {route.path_format}"
            assert ("requestBody" in op) == bool(calls.get("body") or calls.get("upload")), where
            documented = {p["name"] for p in op.get("parameters", [])}
            for part in ("params", "query"):
                if calls.get(part):
                    assert set(calls[part].model_fields) <= documented, where
            assert bool(op.get("security")) == (route.path_format not in public), where


# ---------------------------------------------------------------- zip bombs / log hygiene

async def test_office_zip_bombs_are_refused_before_parsing(client):
    _, auth = await rider(client, "zipbomb@example.com")
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/worksheets/sheet1.xml", b"\0" * (150 * 1024 * 1024))
    res = await client.post("/api/v1/deliveries/import/file", headers=auth,
                            files={"file": ("bomb.xlsx", payload.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res.status_code == 422 and res.json()["error"]["code"] == "FILE_TOO_COMPLEX"


def test_access_log_redacts_signed_url_secrets():
    from app.middleware import _loggable_url

    url = _loggable_url("/api/v1/files/proofs/x.jpg?exp=1&d=inline&sig=SECRETSIG&design=ok")
    assert "SECRETSIG" not in url and "sig=[redacted]" in url and "design=ok" in url
