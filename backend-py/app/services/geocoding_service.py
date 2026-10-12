from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from datetime import timedelta
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..config import env
from ..db import db
from ..errors import AppError
from ..http import now
from ..logger import log
from .geo import normalize_address

TIMEOUT = 8.0
NOMINATIM_INTERVAL = 1.1
_last_nominatim_request = 0.0
_nominatim_lock = asyncio.Lock()

# Riders deliver across a metro area, so a service area is a fixed radius around its centre.
SERVICE_AREA_RADIUS_KM = 35

GENERIC_LOCALITIES = {"house", "street", "road", "avenue", "lane", "block", "sector", "flat", "apartment", "hospital", "near", "opposite"}
BROAD_PLACES = {"pakistan", "india", "bangladesh", "nepal", "sri lanka", "united states", "usa", "united kingdom", "uk", "punjab", "sindh", "balochistan", "khyber pakhtunkhwa"}
BROAD_ADDRESS_TYPES = {"country", "state", "province", "region", "county", "city", "town", "village", "municipality", "district", "suburb", "neighbourhood", "hamlet", "postcode", "borough", "quarter"}


def _area(area: Any, name: str):
    return area.get(name) if isinstance(area, dict) else getattr(area, name)


def expand_address_abbreviations(raw: str) -> str:
    text = re.sub(r"\bDHQ\b", "District Headquarters", str(raw or ""), flags=re.IGNORECASE)
    return re.sub(r"\bTHQ\b", "Tehsil Headquarters", text, flags=re.IGNORECASE).strip()


def locality_queries(raw: str) -> list[str]:
    address = str(raw or "").strip()
    chunks = [part.strip() for part in re.split(r"[\n,]+", address) if part.strip()]
    candidates: list[str] = []
    if len(chunks) > 1:
        while chunks and chunks[-1].lower() in BROAD_PLACES:
            chunks = chunks[:-1]
        for start in range(len(chunks) - 1, -1, -1):
            candidates.append(", ".join(chunks[start:]))
    else:
        words = [w for w in re.split(r"\s+", address) if w]
        while words and " ".join(words[-2:]).lower() in BROAD_PLACES:
            del words[-2:]
        while words and words[-1].lower() in BROAD_PLACES:
            words.pop()
        for count in range(min(3, len(words)), 0, -1):
            candidate = " ".join(words[-count:])
            if not re.fullmatch(r"\d+", candidate) and candidate.lower() not in GENERIC_LOCALITIES:
                candidates.append(candidate)
    original = normalize_address(address)
    return [c for c in dict.fromkeys(candidates) if normalize_address(c) != original]


def area_box(area: Any) -> list[float]:
    """[minLon, minLat, maxLon, maxLat] covering SERVICE_AREA_RADIUS_KM around the area centre."""
    import math

    lat, lon = _area(area, "latitude"), _area(area, "longitude")
    d_lat = SERVICE_AREA_RADIUS_KM / 111
    d_lon = SERVICE_AREA_RADIUS_KM / (111 * max(0.2, math.cos(lat * math.pi / 180)))
    return [lon - d_lon, lat - d_lat, lon + d_lon, lat + d_lat]


def is_inside_area(point: Any, area: Any) -> bool:
    if not area or point is None:
        return True
    lat, lon = _area(point, "latitude"), _area(point, "longitude")
    if lat is None or lon is None:
        return True
    min_lon, min_lat, max_lon, max_lat = area_box(area)
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def _js_number(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else repr(float(n))


async def nominatim(path: str, params: dict) -> Any:
    global _last_nominatim_request
    async with _nominatim_lock:
        wait = _last_nominatim_request + NOMINATIM_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_nominatim_request = time.monotonic()
    query = {"format": "jsonv2", "addressdetails": "1", "accept-language": "en", **params}
    headers = {"User-Agent": env.GEOCODING_USER_AGENT or "delivery-planner (dev)", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get(f"https://nominatim.openstreetmap.org/{path}", params=query, headers=headers)
    if res.status_code >= 400:
        raise RuntimeError(f"Nominatim responded {res.status_code}")
    return res.json()


async def search_nominatim(query: str, area: Any, *, bounded: bool) -> Optional[dict]:
    """Searches near the rider's service area. `bounded` keeps results inside it; otherwise it only restricts the country."""
    params = {"limit": "1", "q": query}
    if area:
        params["countrycodes"] = _area(area, "countryCode")
        if bounded:
            params.update(viewbox=",".join(_js_number(n) for n in area_box(area)), bounded="1")
    hits = await nominatim("search", params)
    if not hits:
        return None
    hit = hits[0]
    return {"latitude": float(hit["lat"]), "longitude": float(hit["lon"]), "normalized": hit.get("display_name"),
            "broad": str(hit.get("addresstype") or "").lower() in BROAD_ADDRESS_TYPES}


def _strip_broad(hit: dict, approximate: bool) -> dict:
    return {k: v for k, v in hit.items() if k != "broad"} | {"approximate": approximate}


async def _provider_none(address: str, area: Any) -> None:
    return None


async def _provider_nominatim(address: str, area: Any) -> Optional[dict]:
    """OSM's public instance allows max 1 request/second and requires an identifying User-Agent."""
    queries = list(dict.fromkeys([address, expand_address_abbreviations(address)]))
    approximate = None

    # 1. The full address inside the rider's city.
    for query in queries:
        hit = await search_nominatim(query, area, bounded=True)
        if hit and not hit["broad"]:
            return _strip_broad(hit, False)
        approximate = approximate or hit
    if not area:
        return _strip_broad(approximate, True) if approximate else None

    # 2. The full address anywhere in the rider's country, for stops that name another town.
    #    A match outside the service area is flagged so the rider double-checks it.
    wider = await search_nominatim(address, area, bounded=False)
    if wider and not wider["broad"]:
        return _strip_broad(wider, not is_inside_area(wider, area))

    # 3. Fragments ("passport office", "main bazar") only ever match inside the city. Searched
    #    worldwide they land on other continents.
    for locality in locality_queries(address):
        hit = await search_nominatim(locality, area, bounded=True)
        if hit and not hit["broad"]:
            return _strip_broad(hit, True)
        approximate = approximate or hit
    return _strip_broad(approximate, True) if approximate else None


async def _provider_google(address: str, area: Any) -> Optional[dict]:
    params = {"address": address, "key": env.GOOGLE_MAPS_API_KEY}
    if area:
        min_lon, min_lat, max_lon, max_lat = area_box(area)
        params["bounds"] = f"{min_lat},{min_lon}|{max_lat},{max_lon}"
        params["components"] = f"country:{_area(area, 'countryCode')}"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get("https://maps.googleapis.com/maps/api/geocode/json", params=params)
    if res.status_code >= 400:
        raise RuntimeError(f"Google Geocoding responded {res.status_code}")
    body = res.json()
    if body.get("status") == "ZERO_RESULTS":
        return None
    if body.get("status") != "OK":
        raise RuntimeError(f"Google Geocoding status {body.get('status')}")
    hit = body["results"][0]
    loc = hit["geometry"]["location"]
    result = {"latitude": loc["lat"], "longitude": loc["lng"], "normalized": hit.get("formatted_address")}
    return {**result, "approximate": hit["geometry"].get("location_type") == "APPROXIMATE" or not is_inside_area(result, area)}


PROVIDERS: dict[str, Callable[[str, Any], Awaitable[Optional[dict]]]] = {
    "none": _provider_none, "nominatim": _provider_nominatim, "google": _provider_google,
}
_lookup = PROVIDERS[env.GEOCODING_PROVIDER]


def set_geocoder_for_tests(fn=None) -> None:
    global _lookup
    _lookup = fn or PROVIDERS[env.GEOCODING_PROVIDER]


# The same text means different places in different cities, so the rider's area is part of the key.
def _area_key(area: Any) -> str:
    if not area:
        return "anywhere"
    return f"{_area(area, 'countryCode')}:{_area(area, 'latitude'):.2f},{_area(area, 'longitude'):.2f}"


def cache_key(raw: str, area: Any) -> str:
    return hashlib.sha1(f"v2|{_area_key(area)}|{normalize_address(raw)}".encode()).hexdigest()


async def geocode_address(raw: str, *, retry_approximate: bool = False, area: Any = None) -> Optional[dict]:
    """Returns {latitude, longitude, normalized, approximate} or None. Provider errors are not cached."""
    key = cache_key(raw, area)
    cached = await db.geocodecache.find_unique(where={"key": key})
    if cached and cached.expiresAt > now() and cached.found and (not retry_approximate or not cached.approximate):
        return {"latitude": cached.latitude, "longitude": cached.longitude, "normalized": cached.normalized, "approximate": bool(cached.approximate)}

    try:
        result = await _lookup(raw, area)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Geocoding provider failed", exc_info=True)
        raise AppError(503, "GEOCODING_UNAVAILABLE", "Address lookup is temporarily unavailable. Check your connection and try planning the route again.") from None
    if result:
        data = {
            "found": True, "latitude": result.get("latitude"), "longitude": result.get("longitude"), "normalized": result.get("normalized"),
            "approximate": bool(result.get("approximate")), "provider": env.GEOCODING_PROVIDER,
            "expiresAt": now() + timedelta(days=7 if result.get("approximate") else 180),
        }
        try:
            await db.geocodecache.upsert(where={"key": key}, data={"create": {"key": key, **data}, "update": data})
        except Exception:  # noqa: BLE001
            pass
    return result


async def geocode_many(addresses: list[str], **options) -> dict[str, Optional[dict]]:
    """Geocodes distinct addresses respecting provider limits. Returns {raw: result|None}."""
    unique = list(dict.fromkeys(addresses))
    out: dict[str, Optional[dict]] = {}

    async def one(raw: str) -> None:
        out[raw] = await geocode_address(raw, **options)

    if env.GEOCODING_PROVIDER == "nominatim":
        for raw in unique:
            await one(raw)
    else:
        queue = list(unique)

        async def worker() -> None:
            while queue:
                await one(queue.pop(0))

        await asyncio.gather(*(worker() for _ in range(min(5, len(queue)))))
    return out


# ---- Rider service area (the city a rider delivers in) ----

def strip_suffix(name: Any) -> str:
    text = re.sub(r"^(Greater|City of)\s+", "", str(name or ""), flags=re.IGNORECASE)
    return re.sub(r"\s+(District|County|Tehsil|Division|Municipality)$", "", text, flags=re.IGNORECASE).strip()


def city_name(wide: Any, local: Any) -> str:
    """OSM nests cities differently per country (London is "Greater London", Lahore a "District")."""
    a = (wide or {}).get("address") or {}
    b = (local or {}).get("address") or {}
    return strip_suffix(a.get("city") or b.get("city") or b.get("town") or a.get("county") or b.get("county") or a.get("district")
                        or b.get("district") or b.get("village") or b.get("municipality") or (local or {}).get("name") or (wide or {}).get("name"))


async def _resolve_area_from_nominatim(point: dict) -> Optional[dict]:
    if env.GEOCODING_PROVIDER == "none":
        return None
    latitude, longitude = point["latitude"], point["longitude"]
    coords = {"lat": _js_number(latitude), "lon": _js_number(longitude)}
    local = await nominatim("reverse", {**coords, "zoom": "10"})
    if not ((local or {}).get("address") or {}).get("country_code"):
        return None
    wide = await nominatim("reverse", {**coords, "zoom": "8"})
    return {"city": city_name(wide, local), "country": local["address"].get("country"),
            "countryCode": local["address"]["country_code"].lower(), "latitude": latitude, "longitude": longitude}


_area_resolver = _resolve_area_from_nominatim


def set_area_resolver_for_tests(fn=None) -> None:
    global _area_resolver
    _area_resolver = fn or _resolve_area_from_nominatim


_area_memo: dict[str, tuple[dict, float]] = {}


async def detect_service_area(point: dict) -> Optional[dict]:
    """Detects the rider's city from a GPS point. Results are reused for nearby points for an hour."""
    memo_key = f"{point['latitude']:.2f},{point['longitude']:.2f}"
    memo = _area_memo.get(memo_key)
    if memo and memo[1] > time.monotonic():
        return memo[0]
    try:
        area = await _area_resolver({"latitude": point["latitude"], "longitude": point["longitude"]})
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Service area lookup failed", exc_info=True)
        raise AppError(503, "GEOCODING_UNAVAILABLE", "Could not detect your city right now. Check your connection and try again.") from None
    if area:
        if len(_area_memo) > 500:
            _area_memo.clear()
        _area_memo[memo_key] = (area, time.monotonic() + 3600)
    return area


async def find_service_area(query: str) -> Optional[dict]:
    """Finds a city typed by the rider, e.g. "London" or "Narowal, Pakistan"."""
    if env.GEOCODING_PROVIDER == "none":
        return None
    try:
        hits = await nominatim("search", {"q": query, "limit": "1", "featureType": "settlement"})
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Service area search failed", exc_info=True)
        raise AppError(503, "GEOCODING_UNAVAILABLE", "Could not look up that city right now. Check your connection and try again.") from None
    hit = hits[0] if hits else None
    if not hit or not (hit.get("address") or {}).get("country_code"):
        return None
    return {
        "city": strip_suffix(hit.get("name") or hit["address"].get("city") or hit["address"].get("town")),
        "country": hit["address"].get("country"),
        "countryCode": hit["address"]["country_code"].lower(),
        "latitude": float(hit["lat"]),
        "longitude": float(hit["lon"]),
    }
