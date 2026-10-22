"""Phase 4 on the server: event history, last-event-wins across devices, late (offline) events, deletes kept, second parcels."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app.db import db

from .test_api import rider
from .test_v2 import TODAY, item, route_with_stops


def key() -> dict:
    return {"Idempotency-Key": str(uuid.uuid4())}


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def events_of(stop_id: str) -> list[tuple[str, str, str]]:
    rows = await db.stopevent.find_many(where={"deliveryId": stop_id}, order={"receivedAt": "asc"})
    return [(e.type, e.outcome, e.source) for e in rows]


# ---------------------------------------------------------------- same event 3x (P4.8)

async def test_the_same_event_three_times_applies_once(client):
    _, auth = await rider(client, "p4-same-3x@example.com")
    built = await route_with_stops(client, auth, 2)
    stop = built["stops"][0]["delivery"]["id"]
    headers = {**auth, **key()}
    # The outbox resends with the same key (retries after a dropped connection) ...
    answers = [await client.post(f"/api/v2/stops/{stop}/events", headers=headers, json={"type": "deliver"}) for _ in range(3)]
    assert [a.status_code for a in answers] == [200, 200, 200]
    assert answers[1].headers.get("idempotent-replayed") == "true" and answers[2].content == answers[0].content
    # ... and a reinstalled app that lost the key sends it again with a new one: still one delivery.
    again = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver"})
    assert again.status_code == 200 and again.json()["data"]["stop"]["status"] == "delivered"
    assert (await db.delivery.find_unique(where={"id": stop})).version == 2  # arrive + deliver, once
    assert await events_of(stop) == [("arrive", "applied", "v2"), ("deliver", "applied", "v2"), ("deliver", "no_change", "v2")]


# ---------------------------------------------------------------- two devices (P4.8)

async def test_two_devices_last_event_by_phone_time_wins_in_either_order(client):
    _, auth = await rider(client, "p4-two-devices@example.com")
    built = await route_with_stops(client, auth, 2)
    first, second = built["stops"][0]["delivery"]["id"], built["stops"][1]["delivery"]["id"]
    t0 = datetime.now(UTC) - timedelta(hours=2)

    # Phone A delivered at t0, phone B failed it at t0+5 min; the server hears A first.
    await client.post(f"/api/v2/stops/{first}/events", headers={**auth, **key()}, json={"type": "deliver", "at": iso(t0)})
    late = await client.post(f"/api/v2/stops/{first}/events", headers={**auth, **key()},
                             json={"type": "fail", "reason": "customer_unavailable", "at": iso(t0 + timedelta(minutes=5))})
    assert late.status_code == 200 and late.json()["data"]["stop"]["status"] == "failed"
    row = await db.delivery.find_unique(where={"id": first})
    assert str(row.status) == "failed" and row.deliveredAt is None and str(row.failureReason) == "customer_unavailable"

    # The other order: B's newer fail arrives first, A's older deliver afterwards changes nothing.
    await client.post(f"/api/v2/stops/{second}/events", headers={**auth, **key()},
                      json={"type": "fail", "reason": "wrong_address", "at": iso(t0 + timedelta(minutes=5)), "allowSkip": True})
    older = await client.post(f"/api/v2/stops/{second}/events", headers={**auth, **key()}, json={"type": "deliver", "at": iso(t0), "allowSkip": True})
    assert older.status_code == 200 and older.json()["data"]["stop"]["status"] == "failed"
    assert ("deliver", "superseded", "v2") in await events_of(second)


# ---------------------------------------------------------------- network drop and a day offline (P4.8)

async def test_a_lost_answer_is_resent_and_late_offline_events_still_count(client):
    _, auth = await rider(client, "p4-network-drop@example.com")
    built = await route_with_stops(client, auth, 3)
    stops = [s["delivery"]["id"] for s in built["stops"]]
    # The phone delivered stop 1 offline 8 hours ago; the request reached the server but the answer was lost.
    headers = {**auth, **key()}
    body = {"type": "deliver", "at": iso(datetime.now(UTC) - timedelta(hours=8))}
    first = await client.post(f"/api/v2/stops/{stops[0]}/events", headers=headers, json=body)
    resent = await client.post(f"/api/v2/stops/{stops[0]}/events", headers=headers, json=body)
    assert first.status_code == resent.status_code == 200 and resent.headers.get("idempotent-replayed") == "true"
    row = await db.delivery.find_unique(where={"id": stops[0]})
    assert abs((row.deliveredAt - datetime.now(UTC)).total_seconds() + 8 * 3600) < 60, "the phone's time is kept"
    # A clock far in the future is treated as now.
    future = await client.post(f"/api/v2/stops/{stops[1]}/events", headers={**auth, **key()},
                               json={"type": "deliver", "at": iso(datetime.now(UTC) + timedelta(days=2))})
    assert future.status_code == 200
    assert (await db.delivery.find_unique(where={"id": stops[1]})).deliveredAt <= datetime.now(UTC)


async def test_fifty_queued_events_after_a_restart_all_land_in_order(client):
    _, auth = await rider(client, "p4-restart-50@example.com")
    built = await route_with_stops(client, auth, 25)
    t0 = datetime.now(UTC) - timedelta(hours=6)
    # 25 arrive + 25 deliver queued offline, sent one after another once the phone is back.
    for i, s in enumerate(built["stops"]):
        stop = s["delivery"]["id"]
        for j, kind in enumerate(("arrive", "deliver")):
            res = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()},
                                    json={"type": kind, "at": iso(t0 + timedelta(minutes=4 * i + j))})
            assert res.status_code == 200, res.text
    route = (await client.get(f"/api/v2/routes/{built['id']}", headers=auth)).json()["data"]
    assert route["status"] == "completed" and route["progress"]["done"] == 25
    rider_id = (await db.route.find_unique(where={"id": built["id"]})).riderId
    assert await db.stopevent.count(where={"riderId": rider_id, "outcome": "applied"}) == 50


async def test_offline_created_stops_resent_twice_are_created_once(client):
    _, auth = await rider(client, "p4-offline-stops@example.com")
    items = [item(i) for i in range(50)]
    for _ in range(2):
        res = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": items})
        assert res.status_code in (200, 201)
    rider_id = (await db.delivery.find_first(where={"clientId": items[0]["clientId"]})).riderId
    assert await db.delivery.count(where={"riderId": rider_id}) == 50


# ---------------------------------------------------------------- history from v1 too (P4.5)

async def test_v1_events_are_recorded_too(client):
    _, auth = await rider(client, "p4-v1-history@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    await client.post(f"/api/v1/deliveries/{stop}/arrive", headers=auth)
    await client.post(f"/api/v1/deliveries/{stop}/fail", headers=auth, json={"reason": "business_closed"})
    assert await events_of(stop) == [("arrive", "applied", "v1"), ("fail", "applied", "v1")]
    refused = await client.post(f"/api/v2/stops/{stop}/events", headers={**auth, **key()}, json={"type": "deliver", "at": iso(datetime.now(UTC) - timedelta(days=1))})
    assert refused.status_code == 200 and (await events_of(stop))[-1] == ("deliver", "superseded", "v2")


# ---------------------------------------------------------------- deletes kept, active route protected (P4.6)

async def test_deletes_are_kept_and_reported_and_clear_open_spares_the_active_route(client):
    _, auth = await rider(client, "p4-deletes@example.com")
    planned = await route_with_stops(client, auth, 2, start=False)
    active = await route_with_stops(client, auth, 2)  # planned after the other one: today's route can't be planned while one runs
    loose = (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(9)]})).json()["data"]["stops"][0]["id"]

    victim = planned["stops"][0]["delivery"]["id"]
    since = iso(datetime.now(UTC) - timedelta(seconds=30))
    assert (await client.delete(f"/api/v1/deliveries/{victim}", headers=auth)).status_code in (200, 204)
    kept = await db.deleteddelivery.find_unique(where={"id": victim})
    assert kept and kept.reason == "delete" and kept.snapshot["id"] == victim
    changes = (await client.get(f"/api/v2/routes/{planned['id']}/changes", headers=auth, params={"since": since})).json()["data"]
    assert victim in changes["removed"]

    cleared = await client.delete("/api/v1/deliveries", headers=auth)
    assert cleared.status_code == 200, cleared.text
    on_active = [s["delivery"]["id"] for s in active["stops"]]
    assert await db.delivery.count(where={"id": {"in": on_active}}) == 2, "stops on the route being driven are never cleared"
    assert not await db.delivery.find_unique(where={"id": loose})
    assert (await db.deleteddelivery.find_unique(where={"id": loose})).reason == "clear_open"


# ---------------------------------------------------------------- same Eircode same day (P4.7)

async def test_same_eircode_same_day_needs_the_second_parcel_confirmation(client):
    _, auth = await rider(client, "p4-second-parcel@example.com")
    first = item(1, address={"raw": "D01 F5P2"})
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [first]})).status_code == 201

    again = item(2, address={"raw": "d01f5p2, Dublin"})
    refused = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [again]})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "SAME_EIRCODE_SAME_DAY"
    assert refused.json()["error"]["details"][0]["postalCode"] == "D01 F5P2"

    confirmed = await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [{**again, "secondParcel": True}]})
    assert confirmed.status_code == 201
    row = await db.delivery.find_first(where={"clientId": again["clientId"]})
    assert row.secondParcel and row.postalCode == "D01 F5P2"
    # Another day, or the same stop sent again, is fine.
    tomorrow = (datetime.now(UTC) + timedelta(days=1)).strftime("%Y-%m-%d")
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [item(3, address={"raw": "D01 F5P2"}, serviceDate=tomorrow)]})).status_code == 201
    assert (await client.post("/api/v2/deliveries/batch", headers=auth, json={"items": [first]})).status_code == 200
    assert TODAY
