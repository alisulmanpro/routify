"""Integration tests ported 1:1 from backend/tests/integration/api.test.js, plus contract checks for the migration."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from app.db import db
from app.ids import new_id
from app.security import hash_password
from app.services import geocoding_service

PASSWORD = "longenough1"


async def register(client, email, name="Rider", currency="USD"):
    res = await client.post("/api/v1/auth/register", json={"fullName": name, "email": email, "password": PASSWORD,
                                                           "confirmPassword": PASSWORD, "currency": currency})
    return res


async def rider(client, email, *, subscribed=True, **kw):
    """A signed-up rider. New accounts start with no plan; `subscribed` puts them on a running free-trial plan
    (as a store trial would), so tests about deliveries and routes can get straight to work."""
    res = await register(client, email, **kw)
    assert res.status_code == 201, res.text
    body = res.json()["data"]
    if subscribed:
        await db.subscription.update_many(where={"userId": body["user"]["id"]},
                                          data={"status": "trialing", "currentPeriodEnd": datetime.now(timezone.utc) + timedelta(days=14)})
    return body, {"Authorization": f"Bearer {body['accessToken']}"}


async def make_admin(client, email):
    await db.user.create(data={"id": new_id(), "fullName": "Admin", "phone": "-", "email": email, "passwordHash": await hash_password(PASSWORD), "role": "owner_admin"})
    login = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD, "client": "web"})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['data']['accessToken']}"}, login


def delivery(tid, raw="Somewhere real enough", **extra):
    return {"trackingId": tid, "customer": {"name": "C", "phone": "03001112223"}, "address": {"raw": raw}, **extra}


async def test_rejects_weak_passwords_and_enforces_email_uniqueness(client):
    weak = await client.post("/api/v1/auth/register", json={"fullName": "A B", "email": "weak@example.com", "password": "123", "confirmPassword": "123", "currency": "USD"})
    assert weak.status_code == 400
    assert (await register(client, "dup@example.com")).status_code == 201
    dup = await register(client, "dup@example.com")
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_delivery_needs_only_parcel_id_and_address(client):
    _, auth = await rider(client, "rider1@example.com", currency="PKR")
    minimal = await client.post("/api/v1/deliveries/manual", headers=auth, json={"trackingId": "T-1", "address": {"raw": "Somewhere real enough"}})
    assert minimal.status_code == 201
    assert minimal.json()["data"]["customer"] == {"name": "", "phone": ""}

    # Older clients may still send payment; it is ignored rather than rejected.
    legacy = await client.post("/api/v1/deliveries/manual", headers=auth, json={**delivery("T-2"), "payment": {"type": "cod"}})
    assert legacy.status_code == 201
    assert "payment" not in legacy.json()["data"]

    no_address = await client.post("/api/v1/deliveries/manual", headers=auth, json={"trackingId": "T-3"})
    assert no_address.status_code == 400


async def test_rider_cannot_see_another_riders_delivery_and_duplicates_rejected(client):
    _, auth1 = await rider(client, "org1@example.com")
    _, auth2 = await rider(client, "org2@example.com")
    created = await client.post("/api/v1/deliveries/manual", headers=auth1, json=delivery("ISO-1", "Real address here"))
    assert created.status_code == 201
    cross = await client.get(f"/api/v1/deliveries/{created.json()['data']['id']}", headers=auth2)
    assert cross.status_code == 404
    dup = await client.post("/api/v1/deliveries/manual", headers=auth1, json=delivery("ISO-1", "Real address here"))
    assert dup.status_code == 409


async def test_deliver_without_proof_and_route_lifecycle_gates(client):
    _, auth = await rider(client, "flow@example.com")
    d = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("FLOW-1", "Real address here"))
    did = d.json()["data"]["id"]

    before_route = await client.post(f"/api/v1/deliveries/{did}/arrive", headers=auth)
    assert before_route.status_code == 409
    assert before_route.json()["error"]["code"] == "ROUTE_NOT_ACTIVE"

    route = await client.post("/api/v1/routes/build", headers=auth, json={})
    assert route.status_code == 201
    start = await client.post(f"/api/v1/routes/{route.json()['data']['id']}/start", headers=auth)
    assert start.status_code == 200

    await client.post(f"/api/v1/deliveries/{did}/arrive", headers=auth)
    done = await client.post(f"/api/v1/deliveries/{did}/deliver", headers=auth, json={})
    assert done.status_code == 200
    assert done.json()["data"]["status"] == "delivered"

    # The last stop finished, so the route completes on its own and shows up in history.
    completed = await client.get("/api/v1/routes", headers=auth)
    assert [r["id"] for r in completed.json()["data"]] == [route.json()["data"]["id"]]
    assert completed.json()["data"][0]["status"] == "completed"


async def test_delivery_order_guard_requires_confirmation(client):
    _, auth = await rider(client, "order-rider@example.com")
    items = [delivery(t, f"Real address for {t}") for t in ("ORDER-1", "ORDER-2")]
    created = await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": items})
    assert created.status_code == 201

    route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": [d["id"] for d in created.json()["data"]]})
    assert route.status_code == 201
    later = route.json()["data"]["stops"][1]["delivery"]["id"]
    await client.post(f"/api/v1/routes/{route.json()['data']['id']}/start", headers=auth)
    await client.post(f"/api/v1/deliveries/{later}/arrive", headers=auth)

    blocked = await client.post(f"/api/v1/deliveries/{later}/deliver", headers=auth, json={})
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "EARLIER_STOPS_REMAIN"

    confirmed = await client.post(f"/api/v1/deliveries/{later}/deliver", headers=auth, json={"allowSkip": True})
    assert confirmed.status_code == 200
    assert confirmed.json()["data"]["status"] == "delivered"


async def test_planned_route_retry_updates_stop_coordinates(client):
    _, auth = await rider(client, "geocode-rider@example.com")
    created = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("GEO-RETRY-1", "DHQ Hospital Narowal"))
    assert created.status_code == 201
    try:
        async def nothing(address, area):
            return None
        geocoding_service.set_geocoder_for_tests(nothing)
        route = await client.post("/api/v1/routes/build", headers=auth, json={})
        assert route.status_code == 201
        rid = route.json()["data"]["id"]
        assert route.json()["data"]["stops"][0]["delivery"]["address"]["geocodeStatus"] == "not_found"

        # A retry first finds only the general area: the stop gets coordinates but stays flagged.
        async def area_only(address, area):
            return {"latitude": 32.1009, "longitude": 74.8722, "normalized": "Narowal, Pakistan", "approximate": True}
        geocoding_service.set_geocoder_for_tests(area_only)
        approx = await client.post(f"/api/v1/routes/{rid}/retry-geocoding", headers=auth)
        assert approx.status_code == 200
        a = approx.json()["data"]["stops"][0]["delivery"]
        assert a["address"]["geocoded"] is False and a["address"]["approximate"] is True
        assert a["address"]["latitude"] == 32.1009
        assert "approximate_location" in a["flags"]

        # Retries look approximate stops up again, so a later exact match upgrades the stop.
        async def exact(address, area):
            return {"latitude": 32.0983, "longitude": 74.8735, "normalized": "DHQ Hospital, Narowal, Pakistan", "approximate": False}
        geocoding_service.set_geocoder_for_tests(exact)
        refreshed = await client.post(f"/api/v1/routes/{rid}/retry-geocoding", headers=auth)
        assert refreshed.status_code == 200
        r = refreshed.json()["data"]["stops"][0]["delivery"]
        assert r["address"]["geocoded"] is True and r["address"]["geocodeStatus"] == "found"
        assert r["address"]["latitude"] == 32.0983
        assert "approximate_location" not in r["flags"]
    finally:
        geocoding_service.set_geocoder_for_tests()


async def test_other_failure_requires_a_description(client):
    _, auth = await rider(client, "failure-rider@example.com")
    created = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("FAIL-OTHER-1", "Real address for failure test"))
    route = await client.post("/api/v1/routes/build", headers=auth, json={})
    await client.post(f"/api/v1/routes/{route.json()['data']['id']}/start", headers=auth)
    did = created.json()["data"]["id"]
    await client.post(f"/api/v1/deliveries/{did}/arrive", headers=auth)

    missing = await client.post(f"/api/v1/deliveries/{did}/fail", headers=auth, json={"reason": "other"})
    assert missing.status_code == 400
    ok = await client.post(f"/api/v1/deliveries/{did}/fail", headers=auth, json={"reason": "other", "note": "Gate was locked"})
    assert ok.status_code == 200
    assert ok.json()["data"]["failure"]["note"] == "Gate was locked"


async def test_report_for_a_past_service_date_downloads_as_pdf(client):
    _, auth = await rider(client, "report-rider@example.com")
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    created = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("REPORT-PAST-1", "Real address for report test", serviceDate=past))
    assert created.status_code == 201

    report = await client.post("/api/v1/reports/generate", headers=auth, json={"date": past})
    assert report.status_code == 201
    data = report.json()["data"]
    assert data["date"] == past
    assert data["summary"]["total"] == 1

    pdf = await client.get(data["downloadUrl"])
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("attachment;")
    assert pdf.content.startswith(b"%PDF-")

    tampered = await client.get(data["downloadUrl"].replace("sig=", "sig=x"))
    assert tampered.status_code == 404

    history = await client.get("/api/v1/rider/history", headers=auth)
    assert history.json()["data"][0] == {"date": past, "total": 1, "delivered": 0, "failed": 0, "pending": 1, "distanceKm": 0, "hasReport": True}


async def test_admin_cannot_be_created_via_register_and_rider_blocked_from_admin(client):
    body, auth = await rider(client, "noadmin@example.com")
    assert body["user"]["role"] == "rider"
    assert (await client.get("/api/v1/admin/overview", headers=auth)).status_code == 403
    assert (await client.get("/api/v1/admin/overview")).status_code == 401


async def test_self_registered_riders_get_their_own_subscription(client):
    body, auth = await rider(client, "solo@example.com")
    assert "organizationId" not in body["user"]
    me = await client.get("/api/v1/subscriptions/me", headers=auth)
    assert me.status_code == 200
    assert me.json()["data"]["subscription"]["userId"] == body["user"]["id"]
    assert me.json()["data"]["subscription"]["planKey"] == "trial"
    d = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("SOLO-1"))
    assert d.status_code == 201
    assert d.json()["data"]["riderId"] == body["user"]["id"]


async def test_two_riders_can_reuse_the_same_tracking_id(client):
    _, auth_a = await rider(client, "ridera@example.com")
    _, auth_b = await rider(client, "riderb@example.com")
    assert (await client.post("/api/v1/deliveries/manual", headers=auth_a, json=delivery("SHARED-1"))).status_code == 201
    assert (await client.post("/api/v1/deliveries/manual", headers=auth_b, json=delivery("SHARED-1", "Somewhere else entirely"))).status_code == 201


async def test_rider_hits_their_plan_delivery_limit(client):
    _, auth = await rider(client, "limit@example.com")
    await db.plan.update(where={"key": "trial"}, data={"deliveriesPerMonth": 2})
    try:
        ok = await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": [delivery("LIM-1", "Addr 1"), delivery("LIM-2", "Addr 2")]})
        assert ok.status_code == 201
        blocked = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("LIM-3", "Addr 3"))
        assert blocked.status_code == 403
        assert blocked.json()["error"]["code"] == "PLAN_LIMIT_REACHED"
    finally:
        await db.plan.update(where={"key": "trial"}, data={"deliveriesPerMonth": 100})


async def test_pending_upgrade_shows_upcoming_plan(client):
    _, auth = await rider(client, "pending@example.com")
    req = await client.post("/api/v1/subscriptions", headers=auth, json={"planKey": "starter", "billingCycle": "monthly"})
    assert req.status_code == 201
    me = (await client.get("/api/v1/subscriptions/me", headers=auth)).json()["data"]
    assert me["subscription"]["planKey"] == "trial"
    assert me["subscription"]["pending"]["planKey"] == "starter"
    assert me["plan"]["name"] == "Starter"


async def test_admin_console_has_no_organization_concept(client):
    auth, _ = await make_admin(client, "ov-admin@example.com")
    overview = await client.get("/api/v1/admin/overview", headers=auth)
    assert overview.status_code == 200
    assert overview.json()["data"]["metrics"]["riders"] >= 1
    assert "organizations" not in overview.json()["data"]["metrics"]

    riders = await client.get("/api/v1/admin/riders", headers=auth, params={"limit": 5})
    assert riders.status_code == 200
    assert all("organizationId" not in r for r in riders.json()["data"])
    assert riders.json()["meta"]["limit"] == 5

    assert (await client.get("/api/v1/admin/organizations", headers=auth)).status_code == 404


async def test_admin_records_manual_payment_and_activates_subscription(client):
    admin_auth, _ = await make_admin(client, "pay-admin@example.com")
    body, auth = await rider(client, "paying@example.com")
    rider_id = body["user"]["id"]

    payment = await client.post("/api/v1/admin/payments", headers=admin_auth, json={"riderId": rider_id, "planKey": "starter", "billingCycle": "monthly", "status": "succeeded"})
    assert payment.status_code == 201
    assert payment.json()["data"]["userId"] == rider_id

    me = (await client.get("/api/v1/subscriptions/me", headers=auth)).json()["data"]
    assert me["subscription"]["planKey"] == "starter"
    assert me["subscription"]["status"] == "active"

    listed = (await client.get("/api/v1/admin/payments", headers=admin_auth)).json()
    assert listed["success"] is True and isinstance(listed["totals"], list) and listed["meta"]["total"] >= 1


async def test_rider_confirms_detected_city_and_lookups_are_scoped(client):
    _, auth = await rider(client, "area-rider@example.com", currency="GBP")
    london = {"city": "London", "country": "United Kingdom", "countryCode": "gb", "latitude": 51.5072, "longitude": -0.1276}
    seen = []
    try:
        async def resolve(point):
            return london
        geocoding_service.set_area_resolver_for_tests(resolve)
        detected = await client.get("/api/v1/rider/service-area/detect", params={"latitude": 51.5072, "longitude": -0.1276}, headers=auth)
        assert detected.status_code == 200
        assert detected.json()["data"]["city"] == "London"

        before = await client.get("/api/v1/auth/me", headers=auth)
        assert before.json()["data"]["serviceArea"] is None, "detecting alone must not save the city"

        confirmed = await client.put("/api/v1/rider/service-area", json={"latitude": 51.5072, "longitude": -0.1276}, headers=auth)
        assert confirmed.status_code == 200
        assert confirmed.json()["data"]["serviceArea"]["city"] == "London"
        assert confirmed.json()["data"]["serviceArea"]["source"] == "gps"

        async def geocode(address, area):
            seen.append(area)
            return {"latitude": 51.51, "longitude": -0.12, "normalized": "London", "approximate": False}
        geocoding_service.set_geocoder_for_tests(geocode)
        await client.post("/api/v1/deliveries/manual", headers=auth, json={"trackingId": "AREA-1", "customer": {"name": "C", "phone": "07700900124"}, "address": {"raw": "10 Downing Street"}})
        route = await client.post("/api/v1/routes/build", headers=auth, json={})
        assert route.status_code == 201
        assert seen[0]["countryCode"] == "gb" and seen[0]["city"] == "London"

        cleared = await client.patch("/api/v1/auth/me", json={"city": None}, headers=auth)
        assert cleared.status_code == 200
        assert cleared.json()["data"]["serviceArea"] is None
    finally:
        geocoding_service.set_geocoder_for_tests()
        geocoding_service.set_area_resolver_for_tests(None)


# ---- extra contract checks: the clients depend on these exact behaviours ----

async def test_refresh_token_rotation_and_reuse_detection(client):
    body, _ = await rider(client, "rotate@example.com")
    first = body["refreshToken"]
    rotated = await client.post("/api/v1/auth/refresh", json={"refreshToken": first, "client": "mobile"})
    assert rotated.status_code == 200
    assert rotated.json()["data"]["refreshToken"] != first
    reused = await client.post("/api/v1/auth/refresh", json={"refreshToken": first})
    assert reused.status_code == 401
    assert reused.json()["error"]["code"] == "REFRESH_TOKEN_REUSED"
    # Reuse revokes the whole family, including the token issued by the rotation.
    after = await client.post("/api/v1/auth/refresh", json={"refreshToken": rotated.json()["data"]["refreshToken"]})
    assert after.status_code == 401


async def test_web_login_uses_an_httponly_cookie_and_csrf_header(client):
    _, login = await make_admin(client, "cookie-admin@example.com")
    assert "refreshToken" not in login.json()["data"]
    cookie = login.headers["set-cookie"]
    assert "dp_rt=" in cookie and "HttpOnly" in cookie and "Path=/api/v1/auth" in cookie
    blocked = await client.post("/api/v1/auth/refresh", json={"client": "web"})
    assert blocked.json()["error"]["code"] == "CSRF_BLOCKED"
    ok = await client.post("/api/v1/auth/refresh", json={"client": "web"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert ok.status_code == 200
    client.cookies.clear()


async def test_error_envelope_ids_and_dates_match_the_node_api(client):
    body, auth = await rider(client, "shape@example.com")
    assert re.fullmatch(r"[0-9a-f]{24}", body["user"]["id"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", body["user"]["createdAt"])

    bad_id = await client.get("/api/v1/deliveries/not-an-id", headers=auth)
    assert bad_id.status_code == 400
    assert bad_id.json()["error"]["code"] == "VALIDATION_ERROR"
    assert bad_id.json()["error"]["details"][0]["location"] == "params"

    missing = await client.get("/api/v1/nope")
    assert missing.status_code == 404
    assert missing.json() == {"success": False, "error": {"code": "NOT_FOUND", "message": "The requested resource was not found", "details": []}}

    bad_json = await client.post("/api/v1/auth/login", content=b"{nope", headers={"Content-Type": "application/json"})
    assert bad_json.status_code == 400 and bad_json.json()["error"]["code"] == "BAD_REQUEST"

    null_name = await client.patch("/api/v1/auth/me", json={"fullName": None}, headers=auth)
    assert null_name.status_code == 400

    listed = await client.get("/api/v1/deliveries/", headers=auth)
    assert listed.status_code == 200 and listed.json()["meta"] == {"page": 1, "limit": 20, "total": 0, "pages": 1}
    assert listed.headers["x-request-id"]
    assert listed.headers["x-content-type-options"] == "nosniff"


async def test_proof_photo_upload_and_signed_url(client):
    _, auth = await rider(client, "proof@example.com")
    d = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("PROOF-1"))
    did = d.json()["data"]["id"]
    route = await client.post("/api/v1/routes/build", headers=auth, json={})
    await client.post(f"/api/v1/routes/{route.json()['data']['id']}/start", headers=auth)
    await client.post(f"/api/v1/deliveries/{did}/arrive", headers=auth)

    fake = await client.post(f"/api/v1/deliveries/{did}/proof", headers=auth, files={"photo": ("p.jpg", b"not an image", "image/jpeg")})
    assert fake.status_code == 415 and fake.json()["error"]["code"] == "INVALID_FILE"
    wrong_type = await client.post(f"/api/v1/deliveries/{did}/proof", headers=auth, files={"photo": ("p.gif", b"GIF89a", "image/gif")})
    assert wrong_type.status_code == 415 and wrong_type.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"

    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
    uploaded = await client.post(f"/api/v1/deliveries/{did}/proof", headers=auth, files={"photo": ("p.jpg", jpeg, "image/jpeg")})
    assert uploaded.status_code == 200, uploaded.text
    url = uploaded.json()["data"]["proof"]["photoUrl"]
    assert url.startswith("/api/v1/files/proofs/") and "&d=inline&sig=" in url
    photo = await client.get(url)
    assert photo.status_code == 200 and photo.content == jpeg
    assert photo.headers["cross-origin-resource-policy"] == "cross-origin"


async def test_pdf_import_reads_a_real_pdf(client):
    from reportlab.pdfgen import canvas
    import io

    _, auth = await rider(client, "import@example.com")
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i, line in enumerate(["Order ID Customer Phone Delivery Address",
                              "ORD-2001 Ali Raza 0300-0001001 House 12, Street 3, Circular Road, Narowal"]):
        c.drawString(40, 800 - i * 20, line)
    c.save()
    res = await client.post("/api/v1/deliveries/import/pdf", headers=auth, files={"file": ("m.pdf", buf.getvalue(), "application/pdf")})
    assert res.status_code == 200, res.text
    assert res.json()["data"]["pages"] == 1
    assert res.json()["data"]["items"][0]["trackingId"] == "ORD-2001"

    csv = b"Order ID,Customer,Phone,Delivery Address\nORD-3001,Sara Khan,0300-0002002,\"House 9, Mall Road, Lahore\"\n"
    res = await client.post("/api/v1/deliveries/import/file", headers=auth, files={"file": ("m.csv", csv, "text/csv")})
    assert res.status_code == 200, res.text
    assert res.json()["data"]["fileType"] == "csv"
    assert res.json()["data"]["items"][0]["trackingId"] == "ORD-3001"


async def test_stops_need_only_an_address_and_routes_keep_their_name(client):
    _, auth = await rider(client, "add-route@example.com")
    # Two stops with no parcel ID do not clash; one carries the location the rider picked.
    first = await client.post("/api/v1/deliveries/manual", headers=auth, json={"address": {"raw": "10 Main Street, Dublin"},
                                                                             "location": {"latitude": 53.35, "longitude": -6.26}})
    second = await client.post("/api/v1/deliveries/manual", headers=auth, json={"trackingId": "", "address": {"raw": "5 Grafton Street, Dublin"}})
    assert first.status_code == 201 and second.status_code == 201, (first.text, second.text)
    assert first.json()["data"]["trackingId"] == "" and second.json()["data"]["trackingId"] == ""
    assert first.json()["data"]["address"]["geocodeStatus"] == "found"
    assert first.json()["data"]["address"]["latitude"] == 53.35

    ids = [first.json()["data"]["id"], second.json()["data"]["id"]]
    built = await client.post("/api/v1/routes/build", headers=auth, json={"name": "Friday north", "preference": "shortest", "deliveryIds": ids})
    assert built.status_code == 201, built.text
    route = built.json()["data"]
    assert route["name"] == "Friday north" and route["preference"] == "shortest"
    assert sorted(s["delivery"]["id"] for s in route["stops"]) == sorted(ids)


async def test_tomorrows_route_can_be_planned_tonight_without_touching_today(client):
    from datetime import date, timedelta

    _, auth = await rider(client, "plan-ahead@example.com")
    today, tomorrow = date.today().isoformat(), (date.today() + timedelta(days=1)).isoformat()
    now_stop = await client.post("/api/v1/deliveries/manual", headers=auth, json={"address": {"raw": "1 Today Street, Dublin"}, "serviceDate": today})
    later_stop = await client.post("/api/v1/deliveries/manual", headers=auth, json={"address": {"raw": "2 Tomorrow Road, Dublin"}, "serviceDate": tomorrow})
    today_route = await client.post("/api/v1/routes/build", headers=auth, json={"name": "Today", "date": today, "deliveryIds": [now_stop.json()["data"]["id"]]})
    later_route = await client.post("/api/v1/routes/build", headers=auth, json={"name": "Tomorrow", "date": tomorrow, "deliveryIds": [later_stop.json()["data"]["id"]]})
    assert today_route.status_code == 201 and later_route.status_code == 201, (today_route.text, later_route.text)

    # Planning tomorrow kept today's planned route, and "current" is still today's.
    current = (await client.get("/api/v1/routes/current", headers=auth, params={"date": today})).json()["data"]
    assert current["id"] == today_route.json()["data"]["id"]
    upcoming = (await client.get("/api/v1/routes/upcoming", headers=auth, params={"date": today})).json()["data"]
    assert [r["name"] for r in upcoming] == ["Tomorrow"] and upcoming[0]["serviceDate"] == tomorrow

    # Today's dashboard does not count tomorrow's stop yet.
    dash = (await client.get("/api/v1/rider/dashboard", headers=auth, params={"date": today})).json()["data"]
    assert dash["total"] == 1 and dash["routeId"] == today_route.json()["data"]["id"]


async def test_plain_text_address_list_imports_without_parcel_ids(client):
    _, auth = await rider(client, "txt-import@example.com")
    txt = b"10 Main Street, Dublin\n5 Grafton Street, Dublin 2\n"
    res = await client.post("/api/v1/deliveries/import/file", headers=auth, files={"file": ("stops.txt", txt, "text/plain")})
    assert res.status_code == 200, res.text
    assert res.json()["data"]["fileType"] == "txt"
    assert [i["address"] for i in res.json()["data"]["items"]] == ["10 Main Street, Dublin", "5 Grafton Street, Dublin 2"]


async def test_address_suggestions_come_from_the_provider(client):
    from app.services import geocoding_service

    _, auth = await rider(client, "suggest@example.com")
    geocoding_service.set_suggester_for_tests(lambda query, area: _async([
        {"label": f"{query}, Dublin", "latitude": 53.34, "longitude": -6.26, "approximate": False},
        {"label": f"{query}, Cork", "latitude": 51.9, "longitude": -8.47, "approximate": True},
    ]))
    try:
        res = await client.post("/api/v1/deliveries/geocode-suggest", headers=auth, json={"query": "Main St", "latitude": 53.35, "longitude": -6.26})
    finally:
        geocoding_service.set_suggester_for_tests()
    assert res.status_code == 200, res.text
    assert [s["label"] for s in res.json()["data"]] == ["Main St, Dublin", "Main St, Cork"]


async def _async(value):
    return value


async def test_geocode_check_looks_up_an_address_without_saving(client):
    _, auth = await rider(client, "geocode-check@example.com")
    try:
        async def found(address, area):
            return {"latitude": 31.52, "longitude": 74.35, "normalized": "Mall Road, Lahore", "approximate": False}
        geocoding_service.set_geocoder_for_tests(found)
        hit = await client.post("/api/v1/deliveries/geocode-check", headers=auth, json={"address": "12 Mall Road Lahore"})
        assert hit.status_code == 200, hit.text
        assert hit.json()["data"] == {"found": True, "approximate": False, "latitude": 31.52, "longitude": 74.35, "normalized": "Mall Road, Lahore"}

        async def nothing(address, area):
            return None
        geocoding_service.set_geocoder_for_tests(nothing)
        miss = await client.post("/api/v1/deliveries/geocode-check", headers=auth, json={"address": "nowhere at all 999"})
        assert miss.status_code == 200
        assert miss.json()["data"]["found"] is False

        bad = await client.post("/api/v1/deliveries/geocode-check", headers=auth, json={"address": "ab"})
        assert bad.status_code == 400
        listed = await client.get("/api/v1/deliveries", headers=auth)
        assert listed.json()["data"] == [], "checking an address must not create a delivery"
    finally:
        geocoding_service.set_geocoder_for_tests()


async def test_optimize_reorders_open_stops_includes_new_ones_and_puts_unresolved_last(client):
    from app.services import routing_service
    _, auth = await rider(client, "optimize-rider@example.com")
    places = {"Near street 1": (53.35, -6.26), "Far street 2": (53.40, -6.26), "Mid street 3": (53.37, -6.26)}
    try:
        async def geocode(address, area):
            hit = places.get(address)
            return {"latitude": hit[0], "longitude": hit[1], "normalized": address, "approximate": False} if hit else None
        geocoding_service.set_geocoder_for_tests(geocode)
        calls = []

        async def matrix(points):
            calls.append(len(points))
            return None  # router down: straight-line fallback
        routing_service.set_matrix_for_tests(matrix)

        for tid, raw in (("OPT-1", "Far street 2"), ("OPT-2", "Near street 1"), ("OPT-3", "Unknown place 9")):
            await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery(tid, raw))
        origin = {"latitude": 53.34, "longitude": -6.26}
        route = (await client.post("/api/v1/routes/build", headers=auth, json={"origin": origin})).json()["data"]
        assert [s["delivery"]["trackingId"] for s in route["stops"]] == ["OPT-2", "OPT-1", "OPT-3"], "unresolved address goes last"
        assert route["optimization"] == "straight_line" and calls, "router was asked, fallback recorded"

        await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("OPT-4", "Mid street 3"))
        current = (await client.get("/api/v1/routes/current", headers=auth)).json()["data"]
        assert current["newStops"] == 1

        optimized = await client.post(f"/api/v1/routes/{route['id']}/optimize", headers=auth, json={"origin": origin})
        assert optimized.status_code == 200, optimized.text
        data = optimized.json()["data"]
        assert [s["delivery"]["trackingId"] for s in data["stops"]] == ["OPT-2", "OPT-4", "OPT-1", "OPT-3"]
        assert data["newStops"] == 0
    finally:
        geocoding_service.set_geocoder_for_tests()
        routing_service.set_matrix_for_tests()


async def test_eircode_is_looked_up_first_and_unfound_stops_can_be_pinned(client):
    _, auth = await rider(client, "eircode-rider@example.com")
    address_queries = []
    try:
        async def by_code(code):
            # Exact Eircode hit far outside the rider's city (Galway); still counts as found.
            return {"latitude": 53.2785, "longitude": -9.0610, "normalized": "University Rd, Galway, H91 TK33", "approximate": False} if code == "H91 TK33" else None

        async def by_address(address, area):
            address_queries.append(address)
            return {"latitude": 53.3494, "longitude": -6.2603, "normalized": address, "approximate": False} if "O'Connell" in address else None
        geocoding_service.set_eircode_geocoder_for_tests(by_code)
        geocoding_service.set_geocoder_for_tests(by_address)

        for tid, raw in (("EIR-1", "University Road, Galway, Co. Galway, H91 TK33, Ireland"),
                         ("EIR-2", "General Post Office, O'Connell St, Dublin 1, D01 X9X9"),  # Eircode unknown → address
                         ("EIR-3", "Nowhere Lane, Atlantis, Z99 ZZZZ")):
            assert (await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery(tid, raw))).status_code == 201
        route = (await client.post("/api/v1/routes/build", headers=auth, json={"origin": {"latitude": 53.3498, "longitude": -6.2603}})).json()["data"]
        by_tid = {s["delivery"]["trackingId"]: s["delivery"] for s in route["stops"]}
        assert by_tid["EIR-1"]["address"]["geocodeStatus"] == "found" and by_tid["EIR-1"]["address"]["latitude"] == 53.2785
        assert not any("H91" in q for q in address_queries), "an Eircode hit skips the address lookup"
        assert by_tid["EIR-2"]["address"]["geocodeStatus"] == "found"
        assert by_tid["EIR-3"]["address"]["geocodeStatus"] == "not_found" and "location_not_found" in by_tid["EIR-3"]["flags"]
        assert [s["delivery"]["trackingId"] for s in route["stops"]] == ["EIR-2", "EIR-1", "EIR-3"]

        bad = await client.post(f"/api/v1/deliveries/{by_tid['EIR-3']['id']}/location", headers=auth, json={"latitude": 95, "longitude": 0})
        assert bad.status_code == 400
        pinned = await client.post(f"/api/v1/deliveries/{by_tid['EIR-3']['id']}/location", headers=auth, json={"latitude": 53.36, "longitude": -6.26})
        assert pinned.status_code == 200, pinned.text
        p = pinned.json()["data"]
        assert p["address"]["geocodeStatus"] == "found" and p["address"]["geocoded"] is True and p["flags"] == []

        optimized = (await client.post(f"/api/v1/routes/{route['id']}/optimize", headers=auth, json={})).json()["data"]
        assert [s["delivery"]["trackingId"] for s in optimized["stops"]] == ["EIR-2", "EIR-3", "EIR-1"], "the pinned stop joins the order"
    finally:
        geocoding_service.set_eircode_geocoder_for_tests()
        geocoding_service.set_geocoder_for_tests()
