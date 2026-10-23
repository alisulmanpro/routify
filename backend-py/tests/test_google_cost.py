"""Phase 5: Places Autocomplete (New) + Details per session, no reverse lookup for Eircodes, cache limits, daily caps, usage counts."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.db import db
from app.services import geocoding_service as geo
from app.services import google_usage

from .test_api import make_admin, rider


def session() -> str:
    return str(uuid.uuid4())


@pytest.fixture
def places():
    """Fake Google Places: records every call."""
    calls: list[tuple] = []

    async def autocomplete(query, area, token):
        calls.append(("autocomplete", query, token))
        return [{"placeId": "ChIJplace1", "label": f"{query} Street, Dublin", "latitude": None, "longitude": None, "approximate": False}]

    async def details(place_id, token):
        calls.append(("details", place_id, token))
        return {"latitude": 53.34, "longitude": -6.26, "normalized": "1 Main Street, Dublin 2, D02 X285", "postalCode": "D02 X285"}

    geo.set_places_for_tests(autocomplete, details)
    yield calls
    geo.set_places_for_tests()


async def test_typing_asks_autocomplete_only_and_a_pick_asks_details_once(client, places):
    _, auth = await rider(client, "p5-autocomplete@example.com")
    token = session()
    for typed in ("1 Mai", "1 Main", "1 Main St"):
        res = await client.post("/api/v2/places/autocomplete", headers=auth, json={"input": typed, "sessionToken": token})
        assert res.status_code == 200, res.text
    suggestion = res.json()["data"]["suggestions"][0]
    assert suggestion["placeId"] == "ChIJplace1" and suggestion["latitude"] is None
    assert [c[0] for c in places] == ["autocomplete"] * 3 and {c[2] for c in places} == {token}

    picked = await client.post("/api/v2/places/details", headers=auth, json={"placeId": "ChIJplace1", "sessionToken": token})
    assert picked.status_code == 200
    assert picked.json()["data"] == {"found": True, "latitude": 53.34, "longitude": -6.26, "normalized": "1 Main Street, Dublin 2, D02 X285",
                                     "postalCode": "D02 X285", "approximate": False}
    assert places[-1] == ("details", "ChIJplace1", token)
    # The same place again (another rider, another day) comes from the cache, within the 30-day limit.
    again = await client.post("/api/v2/places/details", headers=auth, json={"placeId": "ChIJplace1", "sessionToken": session()})
    assert again.json()["data"]["latitude"] == 53.34 and [c[0] for c in places].count("details") == 1
    row = await db.geocodecache.find_first(where={"provider": "google_places"})
    assert row.expiresAt - datetime.now(UTC) <= timedelta(days=30, minutes=1)


async def test_a_typed_eircode_is_one_lookup_with_its_point_and_no_reverse_geocode(client, places, monkeypatch):
    _, auth = await rider(client, "p5-eircode@example.com")
    lookups = []

    async def eircode(code):
        lookups.append(code)
        return {"latitude": 53.35, "longitude": -6.26, "normalized": "Athlone, A65 F4E2", "approximate": False}

    async def no_reverse(*_args, **_kwargs):
        raise AssertionError("an Eircode must not cost a reverse geocode")

    monkeypatch.setattr(geo, "reverse_geocode", no_reverse)
    geo.set_eircode_geocoder_for_tests(eircode)
    try:
        res = await client.post("/api/v2/places/autocomplete", headers=auth, json={"input": "A65 F4E2", "sessionToken": session()})
        first = res.json()["data"]["suggestions"][0]
        assert first["placeId"] is None and first["latitude"] == 53.35
        # The camera's check of a scanned Eircode, and adding it: still that one lookup (cached).
        check = await client.post("/api/v1/deliveries/geocode-check", headers=auth, json={"address": "A65F4E2"})
        assert check.json()["data"]["found"] and check.json()["data"]["postalCode"] == "A65 F4E2"
        added = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [
            {"clientId": str(uuid.uuid4()), "address": {"raw": "A65 F4E2"}, "location": {"latitude": 53.35, "longitude": -6.26}}]})
        assert added.status_code == 201
        assert lookups == ["A65 F4E2"]
        cached = await db.geocodecache.find_many(where={"normalized": "Athlone, A65 F4E2"})
        assert cached and all(c.expiresAt - datetime.now(UTC) <= timedelta(days=30, minutes=1) for c in cached)
    finally:
        geo.set_eircode_geocoder_for_tests()


async def test_found_addresses_are_cached_for_at_most_30_days(client):
    async def found(address, area):
        return {"latitude": 53.3, "longitude": -6.3, "normalized": address, "approximate": False}

    geo.set_geocoder_for_tests(found)
    try:
        await geo.geocode_address("5 Thirty Day Road, Dublin")
    finally:
        geo.set_geocoder_for_tests()
    row = await db.geocodecache.find_unique(where={"key": geo.cache_key("5 Thirty Day Road, Dublin", None)})
    assert row and timedelta(days=29) < row.expiresAt - datetime.now(UTC) <= timedelta(days=30, minutes=1)


async def test_each_rider_has_daily_caps_on_lookups_and_searches(client, places):
    from app.middleware import geocode_daily_limiter, suggest_daily_limiter

    _, auth = await rider(client, "p5-cap-1@example.com")
    _, other = await rider(client, "p5-cap-2@example.com")
    limits = (geocode_daily_limiter.limit, suggest_daily_limiter.limit)
    geocode_daily_limiter.enforce = suggest_daily_limiter.enforce = True
    geocode_daily_limiter.limit, suggest_daily_limiter.limit = 2, 3
    try:
        for _ in range(3):
            assert (await client.post("/api/v2/places/autocomplete", headers=auth, json={"input": "Main", "sessionToken": session()})).status_code == 200
        capped = await client.post("/api/v2/places/autocomplete", headers=auth, json={"input": "Main", "sessionToken": session()})
        assert capped.status_code == 429 and "today" in capped.json()["error"]["message"]
        assert (await client.post("/api/v1/deliveries/geocode-suggest", headers=auth, json={"query": "Main Street"})).status_code == 429
        # Lookups have their own cap, shared by details, check and pin.
        for path, body in (("/api/v2/places/details", {"placeId": "ChIJplace1"}), ("/api/v1/deliveries/geocode-reverse", {"latitude": 53.3, "longitude": -6.3})):
            assert (await client.post(path, headers=auth, json=body)).status_code == 200
        assert (await client.post("/api/v1/deliveries/geocode-check", headers=auth, json={"address": "1 Main Street"})).status_code == 429
        # Another rider is not affected.
        assert (await client.post("/api/v2/places/autocomplete", headers=other, json={"input": "Main", "sessionToken": session()})).status_code == 200
    finally:
        geocode_daily_limiter.limit, suggest_daily_limiter.limit = limits
        geocode_daily_limiter.enforce = suggest_daily_limiter.enforce = None
        await db.ratelimit.delete_many(where={"OR": [{"key": {"startswith": "geocode-day:"}}, {"key": {"startswith": "suggest-day:"}}]})


async def test_google_calls_are_counted_per_rider_api_and_day(client, monkeypatch):
    body, auth = await rider(client, "p5-usage@example.com")

    class FakeResponse:
        status_code = 200

        def __init__(self, data):
            self._data = data

        def json(self):
            return self._data

    class FakeClient:
        def __init__(self, *args, **kwargs): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False

        async def post(self, url, json=None, headers=None):
            assert url == geo.AUTOCOMPLETE_URL and json["sessionToken"] and "displayName" not in headers["X-Goog-FieldMask"]
            return FakeResponse({"suggestions": [{"placePrediction": {"placeId": "ChIJx", "text": {"text": "Main St"}}}]})

        async def get(self, url, params=None, headers=None):
            # Essentials fields only (displayName would bill Place Details Pro).
            assert headers["X-Goog-FieldMask"] == "id,location,formattedAddress,addressComponents" and params["sessionToken"]
            return FakeResponse({"location": {"latitude": 53.1, "longitude": -6.1}, "formattedAddress": "Main St, Dublin",
                                 "addressComponents": [{"longText": "D02 X285", "types": ["postal_code"]}, {"shortText": "IE", "types": ["country"]}]})

    monkeypatch.setattr(geo.httpx, "AsyncClient", FakeClient)
    geo.set_places_for_tests(geo._autocomplete_google, geo._details_google)
    try:
        token = session()
        for _ in range(2):
            await client.post("/api/v2/places/autocomplete", headers=auth, json={"input": "Main", "sessionToken": token})
        details = await client.post("/api/v2/places/details", headers=auth, json={"placeId": "ChIJx", "sessionToken": token})
        assert details.json()["data"]["postalCode"] == "D02 X285"
    finally:
        geo.set_places_for_tests()

    rider_id = body["user"]["id"]
    rows = {r.api: r.calls for r in await db.googleusage.find_many(where={"riderId": rider_id})}
    assert rows == {"places_autocomplete": 2, "places_details": 1}

    admin_auth, _ = await make_admin(client, "p5-usage-admin@example.com")
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    report = await client.get("/api/v1/admin/google-usage", headers=admin_auth, params={"from": today, "to": today, "riderId": rider_id})
    assert report.status_code == 200
    assert {(r["api"], r["calls"]) for r in report.json()["data"]} == {("places_autocomplete", 2), ("places_details", 1)}
    # Calls not made for a rider are counted under "-". (The test client runs requests in this task's context, so the
    # rider set by the requests above is cleared first; on the server each request has its own context.)
    google_usage.current_rider.set(None)
    await google_usage.record("geocoding")
    assert await db.googleusage.find_unique(where={"day_riderId_api": {"day": today, "riderId": "-", "api": "geocoding"}})


async def test_a_batch_reads_the_geocode_cache_once(client, monkeypatch):
    """ISSUE-07: geocode_many prefetches every cache row in one query; no per-address cache read is left."""
    cached = ["1 Cached Lane, Dublin", "2 Cached Lane, Dublin, D02 X285"]
    for raw in cached:
        await db.geocodecache.create(data={"key": geo.cache_key(raw, None), "found": True, "latitude": 53.3, "longitude": -6.2, "normalized": raw,
                                           "expiresAt": datetime.now(UTC) + timedelta(days=1)})
    looked_up: list[str] = []

    async def found(address, area):
        looked_up.append(address)
        return {"latitude": 53.4, "longitude": -6.3, "normalized": address, "approximate": False}

    async def no_single_reads(*args, **kwargs):
        raise AssertionError("geocode_many must not read the cache row by row")

    reads: list[dict] = []
    find_many = type(db.geocodecache).find_many

    async def counted_find_many(self, *args, **kwargs):
        reads.append(kwargs)
        return await find_many(self, *args, **kwargs)

    geo.set_geocoder_for_tests(found)
    monkeypatch.setattr(type(db.geocodecache), "find_unique", no_single_reads)
    monkeypatch.setattr(type(db.geocodecache), "find_many", counted_find_many)
    try:
        out = await geo.geocode_many([*cached, "3 New Lane, Dublin", cached[0]])
    finally:
        geo.set_geocoder_for_tests()
    assert len(reads) == 1, "one cache read for the whole batch"
    assert looked_up == ["3 New Lane, Dublin"], "cache hits never reach the provider"
    assert out[cached[0]]["latitude"] == 53.3 and out["3 New Lane, Dublin"]["latitude"] == 53.4
