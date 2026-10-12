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
