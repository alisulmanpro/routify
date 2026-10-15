"""Unit tests ported 1:1 from backend/tests/unit/*.test.js."""
from __future__ import annotations

from app.services.geocoding_service import is_inside_area, locality_queries
from app.services.pdf_import import extract_deliveries_from_text
from app.services.route_planner import plan_route
from app.services.serializers import clean_delivery_address


# ---- geocoding ----

def test_locality_fallback_strips_country_and_province_suffixes():
    word_address = locality_queries("DHQ Hospital Narowal Punjab Pakistan")
    assert word_address[-1] == "Narowal"
    assert all("punjab" not in q.lower() and "pakistan" not in q.lower() for q in word_address)

    comma_address = locality_queries("House 14, Main Bazar, Narowal, Punjab, Pakistan")
    assert comma_address[-1] == "House 14, Main Bazar, Narowal"
    assert all("punjab" not in q.lower() and "pakistan" not in q.lower() for q in comma_address)


def test_service_area_covers_metro_but_not_other_cities_or_continents():
    narowal = {"latitude": 32.1009, "longitude": 74.8722}
    assert is_inside_area({"latitude": 32.2, "longitude": 74.95}, narowal)
    assert not is_inside_area({"latitude": 31.5204, "longitude": 74.3587}, narowal), "Lahore is a different city"
    assert not is_inside_area({"latitude": 45.4285, "longitude": -75.7139}, narowal), "Gatineau, Canada"
    assert is_inside_area({"latitude": 45.4, "longitude": -75.7}, None), "no area means no restriction"


# ---- PDF import ----

def test_extracts_deliveries_from_labelled_blocks_without_payment_details():
    text = """
Tracking ID: TCS-5001
Customer Name: Bilal Ahmed
Phone: 0333-4445566
Address: House 12, Street 4, Gulshan-e-Iqbal, Karachi
Payment Type: COD
COD Amount: 3200

Tracking ID: TCS-5002
Customer Name: Sana Riaz
Phone: 0321-7778899
Address: Flat 3B, Clifton Block 2, Karachi
Payment Type: Prepaid
Order Value: 1500

Tracking ID: TCS-5003
Customer Name: Unclear Payment Case
Phone: 0300-1112223
Address: Model Town, Lahore
Note: payment on delivery maybe
"""
    items = extract_deliveries_from_text(text)
    assert len(items) == 3
    assert items[0]["trackingId"] == "TCS-5001"
    assert items[0]["address"] == "House 12, Street 4, Gulshan-e-Iqbal, Karachi"
    for item in items:
        assert "paymentType" not in item and "codAmount" not in item and "orderValue" not in item
        assert "payment_needs_review" not in item["flags"]


def test_flags_a_block_with_no_address():
    [item] = extract_deliveries_from_text("Tracking ID: X-1\nCustomer Name: A\nPhone: 03001234567\nPayment Type: COD\nCOD Amount: 100\n")
    assert "missing_address" in item["flags"]


def test_extracts_courier_table_rows():
    text = """
Delivery Planner
FAKE / TEST DELIVERY ORDERS
Order ID Customer Phone Delivery Address
ORD-1001 Ali Raza 0300-0001001 House 12, Street 3, Circular Road, Narowal
ORD-1002 Usman Ahmed 0300-0001002 House 45, Mohalla Islam Pura, Narowal
"""
    items = extract_deliveries_from_text(text)
    assert len(items) == 2
    assert items[0]["trackingId"] == "ORD-1001"
    assert items[0]["customerName"] == "Ali Raza"
    assert items[0]["phone"] == "0300-0001001"
    assert items[0]["address"] == "House 12, Street 3, Circular Road, Narowal"
    assert "paymentType" not in items[0]


def test_strips_trailing_cod_amount_from_table_address():
    [item] = extract_deliveries_from_text("\nOrder ID Customer Phone Delivery Address\nORD-1009 Fahad Aslam 0300-0001009 House 14, Main Bazar, Narowal COD PKR 1,575\n")
    assert item["address"] == "House 14, Main Bazar, Narowal"
    assert "codAmount" not in item


def test_cleans_saved_cod_suffix_only_when_amount_matches():
    assert clean_delivery_address("House 14, Main Bazar, Narowal COD PKR 1,575", {"type": "cod", "codAmount": 1575}) == "House 14, Main Bazar, Narowal"
    assert clean_delivery_address("Flat COD 12, Narowal", {"type": "cod", "codAmount": 1575}) == "Flat COD 12, Narowal"


# ---- route planner ----

def stop(sid, lat, lon):
    return {"id": sid, "latitude": lat, "longitude": lon, "addressKey": sid}


def test_visits_every_stop_exactly_once():
    stops = [stop("a", 24.86, 67.01), stop("b", 24.90, 67.05), stop("c", 24.80, 66.99), stop("d", 24.95, 67.10)]
    plan = plan_route(origin={"latitude": 24.85, "longitude": 67.0}, stops=stops, preference="shortest")
    assert sorted(plan["order"]) == ["a", "b", "c", "d"]
    assert len(plan["legs"]) == 4
    assert plan["distanceKm"] > 0


def test_nearest_first_follows_destination_coordinates():
    plan = plan_route(origin={"latitude": 0, "longitude": 0}, stops=[stop("far", 0, 10), stop("near", 0, 1)], preference="nearest_first")
    assert plan["order"] == ["near", "far"]


def test_smart_groups_stops_at_the_same_address():
    stops = [
        {"id": "a", "latitude": 24.86, "longitude": 67.01, "addressKey": "same"},
        {"id": "b", "latitude": 24.86, "longitude": 67.01, "addressKey": "same"},
        {"id": "c", "latitude": 24.95, "longitude": 67.2, "addressKey": "other"},
    ]
    plan = plan_route(origin={"latitude": 24.85, "longitude": 67.0}, stops=stops, preference="smart")
    assert abs(plan["order"].index("a") - plan["order"].index("b")) == 1, "same-address stops should be adjacent"


def test_empty_stop_list_returns_empty_route():
    plan = plan_route(origin={"latitude": 0, "longitude": 0}, stops=[], preference="smart")
    assert plan == {"order": [], "legs": [], "distanceKm": 0, "durationMin": 0}


# ---- route optimisation (TSP) ----

def _random_table(n, seed, asymmetric=False):
    import random
    rng = random.Random(seed)
    pts = [(rng.random() * 10, rng.random() * 10) for _ in range(n + 1)]
    table = [[0.0] * (n + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        for j in range(n + 1):
            if i != j:
                base = ((pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2) ** 0.5
                table[i][j] = base * (1 + rng.random() * 0.4 if asymmetric else 1)
    return table


def test_exact_solver_matches_brute_force():
    from itertools import permutations

    from app.services.route_planner import path_cost, solve_open_path
    for seed in range(5):
        table = _random_table(7, seed, asymmetric=seed % 2 == 1)
        best = min(path_cost(table, list(p)) for p in permutations(range(1, 8)))
        assert abs(path_cost(table, solve_open_path(table)) - best) < 1e-9


def test_heuristic_for_twenty_stops_beats_plain_nearest_neighbour():
    from app.services.route_planner import _nearest_neighbour, path_cost, solve_open_path
    for seed in range(3):
        table = _random_table(20, seed)
        path = solve_open_path(table)
        assert sorted(path) == list(range(1, 21)), "every stop exactly once"
        assert path_cost(table, path) <= path_cost(table, _nearest_neighbour(table, first=None)) + 1e-9


def test_road_matrix_drives_the_order_and_leg_figures():
    # Straight-line, "b" is nearest; by road (e.g. across a river) "a" is much quicker.
    stops = [stop("a", 0, 0.02), stop("b", 0, 0.01)]
    matrix = {
        "ids": ["__start__", "a", "b"],
        "durations": [[0, 60, 900], [60, 0, 840], [900, 840, 0]],
        "distances": [[0, 1000, 9000], [1000, 0, 8500], [9000, 8500, 0]],
    }
    plan = plan_route(origin={"latitude": 0, "longitude": 0}, stops=stops, preference="shortest", matrix=matrix, service_minutes=0)
    assert plan["order"] == ["a", "b"]
    assert plan["legs"][0] == {"id": "a", "distanceKm": 1.0, "durationMin": 1}
    assert plan["distanceKm"] == 9.5 and plan["durationMin"] == 15


def test_small_routes_keep_every_stop():
    from app.services.route_planner import solve_open_path
    assert solve_open_path([[0.0]]) == []
    assert solve_open_path([[0, 5], [5, 0]]) == [1]
    assert sorted(solve_open_path([[0, 1, 2], [1, 0, 1], [2, 1, 0]])) == [1, 2]


# ---- Eircodes and nearest-next order (route_test_cartons.pdf) ----

# The ten test cartons: Eircode → (place, approximate real coordinates).
TEST_CARTONS = {
    "D01 F5P2": ("GPO", 53.3494, -6.2603), "D02 PN40": ("Trinity", 53.3440, -6.2593), "D03 P6K7": ("Croke Park", 53.3607, -6.2511),
    "D08 VF8H": ("Guinness", 53.3419, -6.2867), "D09 V209": ("DCU", 53.3861, -6.2564), "W23 F2H6": ("Maynooth", 53.3813, -6.5918),
    "A92 EH5C": ("Newgrange", 53.6947, -6.4755), "R95 YRK1": ("Kilkenny", 52.6505, -7.2490), "N37 A6D7": ("Athlone", 53.4232, -7.9406),
    "H91 TK33": ("Galway", 53.2785, -9.0610),
}
TEST_LOCATION = {"latitude": 53.3498, "longitude": -6.2603}


def test_finds_eircodes_in_address_text():
    from app.services.geocoding_service import find_eircode
    assert find_eircode("GENERAL POST OFFICE, O'CONNELL ST, DUBLIN 1, CO. DUBLIN, D01 F5P2, IRELAND") == "D01 F5P2"
    assert find_eircode("Castle Street, Athlone n37a6d7") == "N37 A6D7"
    assert find_eircode("Flat D6W X123") == "D6W X123"
    assert find_eircode("SW1A 1AA London") is None
    assert find_eircode("House 12, Street 5, Lahore 54000") is None


def test_test_cartons_go_nearest_next_from_dublin_city_centre():
    stops = [stop(code, lat, lon) for code, (_, lat, lon) in TEST_CARTONS.items()]
    plan = plan_route(origin=TEST_LOCATION, stops=stops, preference="smart")
    names = [TEST_CARTONS[code][0] for code in plan["order"]]
    assert names[:6] == ["GPO", "Trinity", "Guinness", "Croke Park", "DCU", "Maynooth"]
    assert sorted(names) == sorted(p[0] for p in TEST_CARTONS.values())


def test_nearest_next_uses_road_distance_not_travel_time():
    # "a" is closer by road but slower (traffic); nearest-next goes by distance.
    stops = [stop("a", 0, 0.02), stop("b", 0, 0.01)]
    matrix = {
        "ids": ["__start__", "a", "b"],
        "durations": [[0, 900, 300], [900, 0, 300], [300, 300, 0]],
        "distances": [[0, 1000, 3000], [1000, 0, 2500], [3000, 2500, 0]],
    }
    plan = plan_route(origin={"latitude": 0, "longitude": 0}, stops=stops, preference="shortest", matrix=matrix)
    assert plan["order"] == ["a", "b"]


async def test_google_route_matrix_is_read_in_blocks_by_index(monkeypatch):
    import json

    import httpx

    from app.services import routing_service
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append((len(body["origins"]), len(body["destinations"])))
        assert request.headers["X-Goog-FieldMask"].startswith("originIndex")
        lat = lambda w: w["waypoint"]["location"]["latLng"]["latitude"]
        out = []
        for i, o in enumerate(body["origins"]):
            for j, d in enumerate(body["destinations"]):
                el = {"condition": "ROUTE_EXISTS", "distanceMeters": int(abs(lat(o) - lat(d)) * 1000), "duration": f"{int(abs(lat(o) - lat(d)) * 60)}s"}
                if i:
                    el["originIndex"] = i  # Google leaves zero values out
                if j:
                    el["destinationIndex"] = j
                out.append(el)
        return httpx.Response(200, json=out)

    real = httpx.AsyncClient
    monkeypatch.setattr(routing_service.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    points = [{"latitude": float(i), "longitude": 0.0} for i in range(30)]
    result = await routing_service._google_matrix(points)
    assert sorted(seen) == sorted([(25, 25), (25, 5), (5, 25), (5, 5)])
    assert result["distances"][0][29] == 29000 and result["distances"][29][3] == 26000
    assert result["durations"][2][7] == 300 and result["distances"][4][4] == 0
