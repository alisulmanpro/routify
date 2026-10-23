"""Route writes are all-or-nothing and serialised per rider; one active route per rider; geocoding failures stay local."""
from __future__ import annotations

import asyncio

import pytest
from prisma.errors import UniqueViolationError

from app.db import db
from app.ids import new_id
from app.services import geocoding_service, route_service

from .test_api import rider


def located(tid: str, i: int) -> dict:
    return {"trackingId": tid, "address": {"raw": f"{i} Integrity Street"}, "location": {"latitude": 53.30 + i * 0.001, "longitude": -6.30 + i * 0.001}}


async def stops(client, auth, prefix: str, n: int, *, with_location: bool = True) -> list[str]:
    items = [located(f"{prefix}-{i}", i) if with_location else {"trackingId": f"{prefix}-{i}", "address": {"raw": f"{i} {prefix} Road"}}
             for i in range(n)]
    res = await client.post("/api/v1/deliveries/bulk", headers=auth, json={"items": items})
    assert res.status_code == 201, res.text
    return [d["id"] for d in res.json()["data"]]


async def orders_agree(route_id: str) -> None:
    """deliveries.stopOrder and route_stops.order say the same thing for every stop on the route."""
    rows = {s.deliveryId: s.order for s in await db.routestop.find_many(where={"routeId": route_id})}
    on_route = {d.id: d.stopOrder for d in await db.delivery.find_many(where={"routeId": route_id})}
    assert rows and rows == on_route


async def test_build_and_optimize_write_one_consistent_order(client):
    _, auth = await rider(client, "integrity-order@example.com")
    ids = await stops(client, auth, "ORD", 25)
    route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})
    assert route.status_code == 201, route.text
    route_id = route.json()["data"]["id"]
    await orders_agree(route_id)

    optimized = await client.post(f"/api/v1/routes/{route_id}/optimize", headers=auth, json={"origin": {"latitude": 53.33, "longitude": -6.27}})
    assert optimized.status_code == 200, optimized.text
    await orders_agree(route_id)
    assert [s["order"] for s in optimized.json()["data"]["stops"]] == list(range(1, 26))


async def test_a_failed_build_leaves_nothing_behind(client, monkeypatch):
    _, auth = await rider(client, "integrity-rollback@example.com")
    ids = await stops(client, auth, "RB", 5)

    async def broken(*_args, **_kwargs):
        raise RuntimeError("database went away mid-build")

    monkeypatch.setattr(route_service, "_assign_stops", broken)
    assert (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})).status_code == 500
    monkeypatch.undo()

    rider_id = (await db.delivery.find_unique(where={"id": ids[0]})).riderId
    assert not await db.route.find_many(where={"riderId": rider_id})
    assert not await db.routestop.find_many(where={"deliveryId": {"in": ids}})
    assert all(d.routeId is None and d.stopOrder is None for d in await db.delivery.find_many(where={"id": {"in": ids}}))
    # And the stops can be planned normally afterwards.
    assert (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})).status_code == 201


async def test_a_failed_optimize_keeps_the_previous_order(client, monkeypatch):
    _, auth = await rider(client, "integrity-optimize@example.com")
    ids = await stops(client, auth, "OPT", 6)
    route_id = (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})).json()["data"]["id"]
    before = sorted((s.deliveryId, s.order) for s in await db.routestop.find_many(where={"routeId": route_id}))

    async def broken(*_args, **_kwargs):
        raise RuntimeError("crash after route_stops were deleted")

    monkeypatch.setattr(route_service, "_assign_stops", broken)
    res = await client.post(f"/api/v1/routes/{route_id}/optimize", headers=auth, json={"origin": {"latitude": 53.4, "longitude": -6.4}})
    assert res.status_code == 500
    monkeypatch.undo()

    assert sorted((s.deliveryId, s.order) for s in await db.routestop.find_many(where={"routeId": route_id})) == before
    await orders_agree(route_id)


async def test_two_builds_of_the_same_stops_make_one_route(client):
    _, auth = await rider(client, "integrity-double-tap@example.com")
    ids = await stops(client, auth, "DBL", 8)
    first, second = await asyncio.gather(*(client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids}) for _ in range(2)))
    codes = sorted([first.status_code, second.status_code])
    # Either the second build saw the first one's route (stale) or, if it ran entirely after, took the stops over.
    if codes == [201, 409]:
        loser = first if first.status_code == 409 else second
        assert loser.json()["error"]["code"] == "ROUTE_STALE"
    else:
        assert codes == [201, 201]
    rider_id = (await db.delivery.find_unique(where={"id": ids[0]})).riderId
    routes = await db.route.find_many(where={"riderId": rider_id})
    assert len(routes) == 1, "every stop must be on exactly one route and no empty route may be left behind"
    await orders_agree(routes[0].id)


async def test_only_one_route_can_be_started_at_a_time(client):
    _, auth = await rider(client, "integrity-start@example.com")
    a = (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": await stops(client, auth, "SA", 2)})).json()["data"]["id"]
    b = (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": await stops(client, auth, "SB", 2)})).json()["data"]["id"]
    results = await asyncio.gather(client.post(f"/api/v1/routes/{a}/start", headers=auth), client.post(f"/api/v1/routes/{b}/start", headers=auth))
    assert sorted(r.status_code for r in results) == [200, 409]
    assert next(r for r in results if r.status_code == 409).json()["error"]["code"] == "ROUTE_ACTIVE"
    rider_id = (await db.route.find_unique(where={"id": a})).riderId
    assert await db.route.count(where={"riderId": rider_id, "status": "active"}) == 1


async def test_database_refuses_a_second_active_route_for_a_rider(client):
    body, _ = await rider(client, "integrity-index@example.com")
    rider_id = body["user"]["id"]

    def route(status: str) -> dict:
        return {"id": new_id(), "riderId": rider_id, "serviceDate": "2026-10-22", "preference": "smart", "status": status}

    await db.route.create(data=route("active"))
    await db.route.create(data=route("planned"))
    await db.route.create(data=route("completed"))
    with pytest.raises(UniqueViolationError):
        await db.route.create(data=route("active"))
    # Other riders are unaffected.
    other, _ = await rider(client, "integrity-index-2@example.com")
    await db.route.create(data={**route("active"), "riderId": other["user"]["id"]})


async def test_one_failed_lookup_does_not_fail_the_build(client):
    _, auth = await rider(client, "integrity-geocode@example.com")
    ids = await stops(client, auth, "GEO", 3, with_location=False)

    async def flaky(address, area):
        if address.startswith("1 "):
            raise RuntimeError("provider timed out for this one")
        return {"latitude": 53.35, "longitude": -6.26, "normalized": address, "approximate": False}

    geocoding_service.set_geocoder_for_tests(flaky)
    try:
        route = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})
        assert route.status_code == 201, route.text
        by_tid = {s["delivery"]["trackingId"]: s["delivery"] for s in route.json()["data"]["stops"]}
        assert by_tid["GEO-1"]["address"]["geocodeStatus"] == "pending"  # not "not_found": a retry looks it up again
        assert by_tid["GEO-0"]["address"]["geocodeStatus"] == by_tid["GEO-2"]["address"]["geocodeStatus"] == "found"
    finally:
        geocoding_service.set_geocoder_for_tests()


async def test_a_provider_outage_still_reports_unavailable(client):
    _, auth = await rider(client, "integrity-outage@example.com")
    ids = await stops(client, auth, "OUT", 2, with_location=False)

    async def down(address, area):
        raise RuntimeError("provider is down")

    geocoding_service.set_geocoder_for_tests(down)
    try:
        res = await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})
        assert res.status_code == 503 and res.json()["error"]["code"] == "GEOCODING_UNAVAILABLE"
    finally:
        geocoding_service.set_geocoder_for_tests()


async def test_not_found_is_cached_for_a_day_but_a_retry_asks_again(client, monkeypatch):
    calls = []

    async def nothing(address, area):
        calls.append(address)

    monkeypatch.setattr(geocoding_service, "_caches_misses", lambda: True)
    geocoding_service.set_geocoder_for_tests(nothing)
    try:
        assert await geocoding_service.geocode_address("Nowhere Lane 404") is None
        assert await geocoding_service.geocode_address("Nowhere Lane 404") is None
        assert calls == ["Nowhere Lane 404"]
        cached = await db.geocodecache.find_unique(where={"key": geocoding_service.cache_key("Nowhere Lane 404", None)})
        assert cached and not cached.found
        assert (cached.expiresAt - cached.expiresAt.now(cached.expiresAt.tzinfo)).total_seconds() <= 86_400
        await geocoding_service.geocode_address("Nowhere Lane 404", retry_approximate=True)
        assert len(calls) == 2
    finally:
        geocoding_service.set_geocoder_for_tests()


async def test_out_of_order_delivery_is_refused_with_the_first_open_stop(client):
    _, auth = await rider(client, "integrity-order-guard@example.com")
    ids = await stops(client, auth, "OOO", 6)
    route = (await client.post("/api/v1/routes/build", headers=auth, json={"deliveryIds": ids})).json()["data"]
    await client.post(f"/api/v1/routes/{route['id']}/start", headers=auth)
    last = route["stops"][-1]["delivery"]
    await client.post(f"/api/v1/deliveries/{last['id']}/arrive", headers=auth)
    blocked = await client.post(f"/api/v1/deliveries/{last['id']}/deliver", headers=auth, json={})
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "EARLIER_STOPS_REMAIN"
    assert blocked.json()["error"]["details"] == [{"trackingId": route["stops"][0]["delivery"]["trackingId"], "stopOrder": 1}]
