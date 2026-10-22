"""/api/v2: lean responses, ETag/304, change feed, idempotent stop events and uploads, client-id batches; /api/v1 unchanged."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from app.db import db

from .test_api import rider

TODAY = datetime.now(UTC).strftime("%Y-%m-%d")
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def item(i: int, **extra) -> dict:
    return {"clientId": str(uuid.uuid4()), "trackingId": f"V2-{uuid.uuid4().hex[:8]}-{i}", "address": {"raw": f"{i} Lean Street, Dublin"},
            "location": {"latitude": 53.30 + i * 0.001, "longitude": -6.30 + i * 0.001}, "serviceDate": TODAY, **extra}


def key() -> dict:
    return {"Idempotency-Key": str(uuid.uuid4())}


async def route_with_stops(client, auth, n: int = 4, *, start: bool = True) -> dict:
    created = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(i) for i in range(n)]})
    assert created.status_code == 201, created.text
    ids = [s["id"] for s in created.json()["data"]["stops"]]
    route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids, "date": TODAY})
    assert route.status_code == 201, route.text
    if start:
        assert (await client.post(f"/api/v1/routes/{route.json()['data']['id']}/start", headers=auth)).status_code == 200
    return route.json()["data"]


STOP_KEYS = {"id", "order", "status", "trackingId", "customerName", "address", "legDistanceKm", "legDurationMin", "failureReason", "deliveredAt", "failedAt"}
ADDRESS_KEYS = {"raw", "normalized", "latitude", "longitude", "geocoded", "approximate", "geocodeStatus", "postalCode"}


# ---------------------------------------------------------------- batch create (P2.6)

async def test_batch_creates_once_per_client_id(client):
    _, auth = await rider(client, "v2-batch@example.com")
    items = [item(i) for i in range(3)]
    first = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": items})
    assert first.status_code == 201, first.text
    data = first.json()["data"]
    assert data["created"] == 3 and data["existing"] == 0
    assert [s["clientId"] for s in data["stops"]] == [i["clientId"] for i in items]
    assert set(data["stops"][0]) == STOP_KEYS | {"clientId", "serviceDate", "routeId"} and set(data["stops"][0]["address"]) == ADDRESS_KEYS

    # The same batch again (a lost response) plus one new stop: nothing is duplicated.
    again = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [*items, item(9)]})
    assert again.status_code == 201
    assert again.json()["data"]["created"] == 1 and again.json()["data"]["existing"] == 3
    assert [s["id"] for s in again.json()["data"]["stops"][:3]] == [s["id"] for s in data["stops"]]
    rider_id = (await db.delivery.find_unique(where={"id": data["stops"][0]["id"]})).riderId
    assert await db.delivery.count(where={"riderId": rider_id}) == 4

    # All known: 200, nothing created.
    replay = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": items})
    assert replay.status_code == 200 and replay.json()["data"]["created"] == 0


async def test_batch_validates_ids_size_and_duplicates(client):
    _, auth = await rider(client, "v2-batch-rules@example.com")
    dup = item(1)
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [dup, dup]})).status_code == 400
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [{**item(1), "clientId": "not-a-uuid"}]})).status_code == 400
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(i) for i in range(501)]})).status_code == 400
    taken = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(1, trackingId="SAME-PARCEL")]})
    assert taken.status_code == 201
    clash = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(2, trackingId="SAME-PARCEL")]})
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "DUPLICATE_TRACKING_ID"
    # Two riders may use the same client ids.
    _, other = await rider(client, "v2-batch-other@example.com")
    assert (await client.post("/api/v2/deliveries/batch", headers=other, json={"items": [item(1, clientId=dup["clientId"])]})).status_code == 201


async def test_concurrent_identical_batches_make_one_set_of_stops(client):
    _, auth = await rider(client, "v2-batch-race@example.com")
    items = [item(i) for i in range(5)]
    results = await asyncio.gather(*(client.post("/api/v2/deliveries/batch", headers=auth, json={"items": items}) for _ in range(3)))
    assert all(r.status_code in (200, 201) for r in results)
    rider_id = (await db.delivery.find_first(where={"clientId": items[0]["clientId"]})).riderId
    assert await db.delivery.count(where={"riderId": rider_id}) == 5


# ---------------------------------------------------------------- route + ETag (P2.3)

async def test_route_is_light_and_answers_304_when_unchanged(client):
    _, auth = await rider(client, "v2-route@example.com")
    built = await route_with_stops(client, auth, 4, start=False)
    res = await client.get(f"/api/v2/routes/{built['id']}", headers=auth)
    assert res.status_code == 200, res.text
    route = res.json()["data"]
    assert set(route) == {"id", "name", "status", "serviceDate", "preference", "optimization", "origin", "distanceKm", "durationMin",
                          "progress", "summary", "nextStopId", "stops"}
    assert set(route["stops"][0]) == STOP_KEYS and [s["order"] for s in route["stops"]] == [1, 2, 3, 4]
    assert [s["id"] for s in route["stops"]] == [s["delivery"]["id"] for s in built["stops"]]
    assert route["nextStopId"] == route["stops"][0]["id"] and route["progress"] == {"total": 4, "done": 0, "remaining": 4}

    etag = res.headers["etag"]
    same = await client.get(f"/api/v2/routes/{built['id']}", headers={**auth, "If-None-Match": etag})
    assert same.status_code == 304 and same.content == b"" and same.headers["etag"] == etag

    # Any change on the route gives a new ETag.
    await client.post(f"/api/v1/routes/{built['id']}/start", headers=auth)
    after_start = await client.get(f"/api/v2/routes/{built['id']}", headers={**auth, "If-None-Match": etag})
    assert after_start.status_code == 200 and after_start.headers["etag"] != etag
    etag = after_start.headers["etag"]
    await client.post(f"/api/v2/stops/{route['stops'][0]['id']}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert (await client.get(f"/api/v2/routes/{built['id']}", headers={**auth, "If-None-Match": etag})).status_code == 200


async def test_other_riders_routes_are_not_found(client):
    _, auth = await rider(client, "v2-owner@example.com")
    built = await route_with_stops(client, auth, 2, start=False)
    _, stranger = await rider(client, "v2-stranger@example.com")
    assert (await client.get(f"/api/v2/routes/{built['id']}", headers=stranger)).status_code == 404
    assert (await client.get(f"/api/v2/routes/{built['id']}/changes", headers=stranger, params={"since": TODAY + "T00:00:00Z"})).status_code == 404
    stop = built["stops"][0]["delivery"]["id"]
    assert (await client.post(f"/api/v2/stops/{stop}/events", headers={**stranger, **key()}, json={"type": "arrive"})).status_code == 404


# ---------------------------------------------------------------- change feed (P2.4)

async def test_changes_return_only_what_changed_since_the_cursor(client):
    _, auth = await rider(client, "v2-changes@example.com")
    built = await route_with_stops(client, auth, 4)
    first = await client.get(f"/api/v2/routes/{built['id']}/changes", headers=auth, params={"since": "2000-01-01T00:00:00.000Z"})
    assert first.status_code == 200, first.text
    data = first.json()["data"]
    assert len(data["stops"]) == 4 and data["stopCount"] == 4 and data["removed"] == []

    # Rows written in the last few seconds are always resent (clock slack), so step the cursor past them for this test.
    rider_id = (await db.route.find_unique(where={"id": built["id"]})).riderId
    await db.delivery.update_many(where={"riderId": rider_id}, data={"updatedAt": datetime.now(UTC) - timedelta(minutes=5)})
    cursor = (datetime.now(UTC) - timedelta(seconds=30)).isoformat()
    quiet = await client.get(f"/api/v2/routes/{built['id']}/changes", headers=auth, params={"since": cursor})
    assert quiet.json()["data"]["stops"] == []

    stop = built["stops"][1]["delivery"]["id"]
    await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver", "allowSkip": True})
    changed = (await client.get(f"/api/v2/routes/{built['id']}/changes", headers=auth, params={"since": cursor})).json()["data"]
    assert [s["id"] for s in changed["stops"]] == [stop] and changed["stops"][0]["status"] == "delivered" and changed["stops"][0]["order"] == 2
    assert changed["route"]["progress"]["done"] == 1 and changed["cursor"]

    bad = await client.get(f"/api/v2/routes/{built['id']}/changes", headers=auth, params={"since": "yesterday-ish"})
    assert bad.status_code == 400


# ---------------------------------------------------------------- stop events + idempotency (P2.5, P2.1)

async def test_deliver_in_one_request_with_the_route_progress(client):
    _, auth = await rider(client, "v2-events@example.com")
    built = await route_with_stops(client, auth, 3)
    first = built["stops"][0]["delivery"]["id"]
    res = await client.post(f"/api/v2/stops/{first}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["stop"]["status"] == "delivered" and set(data["stop"]) == STOP_KEYS
    assert data["route"]["progress"] == {"total": 3, "done": 1, "remaining": 2}
    assert data["route"]["nextStopId"] == built["stops"][1]["delivery"]["id"] and data["route"]["status"] == "active"

    third = built["stops"][2]["delivery"]["id"]
    blocked = await client.post(f"/api/v2/stops/{third}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "EARLIER_STOPS_REMAIN"
    failed = await client.post(f"/api/v2/stops/{built['stops'][1]['delivery']['id']}/events", headers={**auth, **key()},
                               json={"type": "fail", "reason": "customer_unavailable"})
    assert failed.status_code == 200 and failed.json()["data"]["stop"]["failureReason"] == "customer_unavailable"
    last = await client.post(f"/api/v2/stops/{third}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert last.json()["data"]["route"]["status"] == "completed" and last.json()["data"]["route"]["nextStopId"] is None


async def test_same_key_same_request_replays_without_a_second_change(client):
    _, auth = await rider(client, "v2-idem@example.com")
    built = await route_with_stops(client, auth, 2)
    stop = built["stops"][0]["delivery"]["id"]
    headers = {**auth, **key()}
    first = await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "deliver", "note": "Left with neighbour"})
    row = await db.delivery.find_unique(where={"id": stop})
    again = await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "deliver", "note": "Left with neighbour"})
    assert first.status_code == again.status_code == 200
    assert again.headers.get("idempotent-replayed") == "true" and again.content == first.content
    after = await db.delivery.find_unique(where={"id": stop})
    assert after.version == row.version and after.deliveredAt == row.deliveredAt

    # The same key with a different request is refused.
    other = await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "deliver", "note": "Different"})
    assert other.status_code == 409 and other.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    elsewhere = await client.post(f"/api/v2/stops/{built['stops'][1]['delivery']['id']}/events", headers=headers, json={"type": "deliver", "note": "Left with neighbour"})
    assert elsewhere.status_code == 409 and elsewhere.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_a_new_key_for_an_event_already_applied_still_succeeds(client):
    """A phone that lost its key (or a second device) repeating "deliver" gets 200 and the stop as it is, not 409."""
    _, auth = await rider(client, "v2-repeat@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    assert (await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver"})).status_code == 200
    version = (await db.delivery.find_unique(where={"id": stop})).version
    repeat = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert repeat.status_code == 200 and repeat.json()["data"]["stop"]["status"] == "delivered"
    assert (await db.delivery.find_unique(where={"id": stop})).version == version


async def test_errors_are_replayed_too_and_keys_are_required(client):
    _, auth = await rider(client, "v2-idem-errors@example.com")
    built = await route_with_stops(client, auth, 2, start=False)
    stop = built["stops"][0]["delivery"]["id"]
    headers = {**auth, **key()}
    not_started = await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "arrive"})
    assert not_started.status_code == 409 and not_started.json()["error"]["code"] == "ROUTE_NOT_ACTIVE"
    await client.post(f"/api/v1/routes/{built['id']}/start", headers=auth)
    # Same key: the stored answer, even though the route is active now. A new key runs for real.
    assert (await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "arrive"})).status_code == 409
    assert (await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "arrive"})).status_code == 200

    missing = await client.post(f"/api/v2/stops/{stop}/events", headers=auth, json={"type": "arrive"})
    assert missing.status_code == 400 and missing.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    short = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, "Idempotency-Key": "abc"}, json={"type": "arrive"})
    assert short.status_code == 400 and short.json()["error"]["code"] == "INVALID_IDEMPOTENCY_KEY"
    no_reason = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "fail"})
    assert no_reason.status_code == 400


async def test_parallel_requests_with_one_key_apply_once(client):
    _, auth = await rider(client, "v2-idem-race@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    headers = {**auth, **key()}
    results = await asyncio.gather(*(client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "deliver"}) for _ in range(4)))
    codes = sorted(r.status_code for r in results)
    assert codes.count(200) >= 1 and set(codes) <= {200, 409}
    for r in results:
        if r.status_code == 409:
            assert r.json()["error"]["code"] == "IDEMPOTENCY_IN_PROGRESS"
    assert (await db.delivery.find_unique(where={"id": stop})).version == 2  # arrive + deliver, once


async def test_expired_keys_are_cleaned_up(client):
    from app.main import run_maintenance

    body, auth = await rider(client, "v2-idem-expiry@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, "Idempotency-Key": "expire-me-123"}, json={"type": "arrive"})
    await db.idempotencykey.update_many(where={"riderId": body["user"]["id"]}, data={"expiresAt": datetime.now(UTC) - timedelta(minutes=1)})
    await run_maintenance()
    assert not await db.idempotencykey.find_many(where={"riderId": body["user"]["id"]})


# ---------------------------------------------------------------- proof upload (P2.7)

async def test_proof_upload_after_delivery_and_idempotent(client):
    _, auth = await rider(client, "v2-proof@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver"})

    headers = {**auth, **key()}
    up = await client.post("/api/v2/uploads/proof", params={"stopId": stop}, headers=headers, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    assert up.status_code == 200, up.text
    proof = up.json()["data"]["proof"]
    assert up.json()["data"]["stopId"] == stop and proof["photoUrl"].startswith("/api/v1/files/proofs/")
    assert (await client.get(proof["photoUrl"])).content == JPEG

    again = await client.post("/api/v2/uploads/proof", params={"stopId": stop}, headers=headers, files={"photo": ("other-name.jpg", JPEG, "image/jpeg")})
    assert again.status_code == 200 and again.headers.get("idempotent-replayed") == "true"
    other = await client.post("/api/v2/uploads/proof", params={"stopId": stop}, headers=headers,
                              files={"photo": ("p.jpg", JPEG + b"\x01", "image/jpeg")})
    assert other.status_code == 409

    missing_key = await client.post("/api/v2/uploads/proof", params={"stopId": stop}, headers=auth, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    assert missing_key.status_code == 400
    pending = (await route_with_stops(client, auth, 1, start=False))["stops"][0]["delivery"]["id"]
    early = await client.post("/api/v2/uploads/proof", params={"stopId": pending}, headers={**auth, **key()}, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    assert early.status_code == 409 and early.json()["error"]["code"] == "INVALID_STATE"


# ---------------------------------------------------------------- home (P2.2)

async def test_home_is_one_request_with_counts_only(client):
    _, auth = await rider(client, "v2-home@example.com")
    built = await route_with_stops(client, auth, 3)
    await client.post(f"/api/v2/stops/{built['stops'][0]['delivery']['id']}/events", headers={**auth, **key()}, json={"type": "deliver"})
    tomorrow = (datetime.now(UTC) + timedelta(days=1)).strftime("%Y-%m-%d")
    await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(7, serviceDate=tomorrow), item(8, serviceDate=TODAY)]})

    res = await client.get("/api/v2/rider/home", headers=auth, params={"date": TODAY})
    assert res.status_code == 200, res.text
    home = res.json()["data"]
    assert set(home) == {"rider", "date", "today", "routes", "unplanned", "leftOver"}
    assert home["today"] == {"total": 4, "delivered": 1, "failed": 0, "progressPercent": 25}
    assert home["routes"] == [{"id": built["id"], "name": None, "status": "active", "serviceDate": TODAY, "stops": 3}]
    assert home["unplanned"] == [{"date": TODAY, "count": 1}, {"date": tomorrow, "count": 1}]
    assert home["leftOver"] == {"total": 0, "days": []}

    # The same numbers v1's four Home requests give.
    dash = (await client.get("/api/v1/rider/dashboard", headers=auth, params={"date": TODAY})).json()["data"]
    assert (dash["total"], dash["delivered"], dash["failed"], dash["progressPercent"]) == (4, 1, 0, 25)


# ---------------------------------------------------------------- v1 regression (P2.9)

V1_ROUTE_KEYS = {"id", "name", "status", "preference", "serviceDate", "origin", "distanceKm", "durationMin", "startedAt", "completedAt",
                 "optimization", "newStops", "stops", "progress", "currentStopId", "summary"}
V1_DELIVERY_KEYS = {"id", "riderId", "trackingId", "customer", "address", "status", "proof", "note", "failure", "serviceDate", "routeId",
                    "stopOrder", "arrivedAt", "deliveredAt", "failedAt", "createdAt", "flags"}


async def test_v1_keeps_its_shapes_and_behaviour(client):
    _, auth = await rider(client, "v2-v1-regression@example.com")
    created = await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": [
        {"trackingId": "V1-A", "address": {"raw": "1 Old Street"}, "location": {"latitude": 53.3, "longitude": -6.3}},
        {"trackingId": "V1-B", "address": {"raw": "2 Old Street"}, "location": {"latitude": 53.31, "longitude": -6.31}},
    ]})
    assert created.status_code == 201 and set(created.json()["data"][0]) == V1_DELIVERY_KEYS
    ids = [d["id"] for d in created.json()["data"]]
    route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})
    assert route.status_code == 201 and set(route.json()["data"]) == V1_ROUTE_KEYS
    assert set(route.json()["data"]["stops"][0]) == {"order", "legDistanceKm", "legDurationMin", "delivery"}
    assert set(route.json()["data"]["stops"][0]["delivery"]) == V1_DELIVERY_KEYS
    route_id = route.json()["data"]["id"]
    for path in (f"/api/v1/routes/{route_id}", "/api/v1/routes/current"):
        res = await client.get(path, headers=auth)
        assert res.status_code == 200 and set(res.json()["data"]) == V1_ROUTE_KEYS and "etag" not in res.headers

    await client.post(f"/api/v1/routes/{route_id}/start", headers=auth)
    first, second = route.json()["data"]["stops"][0]["delivery"]["id"], route.json()["data"]["stops"][1]["delivery"]["id"]
    # v1 still needs arrive before deliver, still answers a repeated deliver with 409, and needs no Idempotency-Key.
    assert (await client.post(f"/api/v1/deliveries/{first}/deliver", headers=auth, json={})).json()["error"]["code"] == "INVALID_STATE"
    assert (await client.post(f"/api/v1/deliveries/{first}/arrive", headers=auth)).status_code == 200
    delivered = await client.post(f"/api/v1/deliveries/{first}/deliver", headers=auth, json={})
    assert delivered.status_code == 200 and set(delivered.json()["data"]) == V1_DELIVERY_KEYS
    assert (await client.post(f"/api/v1/deliveries/{first}/deliver", headers=auth, json={})).status_code == 409
    # v1 proof still needs the stop in progress.
    await client.post(f"/api/v1/deliveries/{second}/arrive", headers=auth)
    assert (await client.post(f"/api/v1/deliveries/{first}/proof", headers=auth, files={"photo": ("p.jpg", JPEG, "image/jpeg")})).status_code == 409

    dash = (await client.get("/api/v1/rider/dashboard", headers=auth, params={"date": TODAY})).json()["data"]
    assert set(dash) == {"rider", "date", "total", "delivered", "failed", "pending", "distanceKm", "routeMinutes", "progressPercent", "routeId",
                         "routeStatus", "nextAction", "map"}
    by_date = (await client.get("/api/v1/routes/by-date", headers=auth, params={"from": TODAY})).json()["data"]
    assert set(by_date[0]) == {"id", "name", "status", "preference", "serviceDate", "distanceKm", "durationMin", "startedAt", "completedAt", "progress", "summary"}
    assert (await client.get("/api/v1/routes/leftover", headers=auth, params={"date": TODAY})).json()["data"] == {"total": 0, "days": []}
