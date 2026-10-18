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


async def google_geocode(params: dict) -> list[dict]:
    """Calls the Google Geocoding API (forward or reverse). Returns its results; [] when nothing matched."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get("https://maps.googleapis.com/maps/api/geocode/json", params={**params, "key": env.GOOGLE_MAPS_API_KEY})
    if res.status_code >= 400:
        raise RuntimeError(f"Google Geocoding responded {res.status_code}")
    body = res.json()
    if body.get("status") == "ZERO_RESULTS":
        return []
    if body.get("status") != "OK":
        raise RuntimeError(f"Google Geocoding status {body.get('status')}: {body.get('error_message', '')}")
    return body["results"]


def _google_component(result: dict, *types: str, short: bool = False) -> Optional[str]:
    for wanted in types:
        for part in result.get("address_components", []):
            if wanted in part.get("types", []):
                return part["short_name" if short else "long_name"]
    return None


def _google_area(result: dict, latitude: float, longitude: float) -> Optional[dict]:
    country_code = _google_component(result, "country", short=True)
    if not country_code:
        return None
    city = _google_component(result, "locality", "postal_town", "administrative_area_level_2", "administrative_area_level_1")
    return {"city": strip_suffix(city), "country": _google_component(result, "country"), "countryCode": country_code.lower(),
            "latitude": latitude, "longitude": longitude}


async def _provider_google(address: str, area: Any) -> Optional[dict]:
    params = {"address": address}
    if area:
        min_lon, min_lat, max_lon, max_lat = area_box(area)
        params["bounds"] = f"{min_lat},{min_lon}|{max_lat},{max_lon}"
        params["components"] = f"country:{_area(area, 'countryCode')}"
    results = await google_geocode(params)
    result = None
    if results:
        hit = results[0]
        loc = hit["geometry"]["location"]
        result = {"latitude": loc["lat"], "longitude": loc["lng"], "normalized": hit.get("formatted_address")}
        result["approximate"] = hit["geometry"].get("location_type") == "APPROXIMATE" or not is_inside_area(result, area)
    # Place names ("railway station", "City Hospital") are what Geocoding is worst at: look them up as places in the city.
    if area and (not result or result["approximate"]):
        try:
            places = await google_places(address, area, limit=1)
        except Exception:  # noqa: BLE001 - the geocoding answer (if any) still stands
            log(logging.WARNING, "Places lookup failed", exc_info=True)
            places = []
        if places:
            p = places[0]
            return {"latitude": p["latitude"], "longitude": p["longitude"], "normalized": p["label"], "approximate": False}
    return result


async def google_places(query: str, area: Any, *, limit: int) -> list[dict]:
    """Places API (New) Text Search, restricted to the rider's service area. [{label, latitude, longitude}]."""
    min_lon, min_lat, max_lon, max_lat = area_box(area)
    body = {"textQuery": query, "pageSize": limit,
            "locationRestriction": {"rectangle": {"low": {"latitude": min_lat, "longitude": min_lon}, "high": {"latitude": max_lat, "longitude": max_lon}}}}
    headers = {"X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post("https://places.googleapis.com/v1/places:searchText", json=body, headers=headers)
    if res.status_code >= 400:
        raise RuntimeError(f"Google Places responded {res.status_code}")
    out = []
    for place in res.json().get("places", []):
        name = (place.get("displayName") or {}).get("text") or ""
        address = place.get("formattedAddress") or ""
        label = address if not name or address.lower().startswith(name.lower()) else f"{name}, {address}" if address else name
        out.append({"label": label, "latitude": place["location"]["latitude"], "longitude": place["location"]["longitude"]})
    return out


PROVIDERS: dict[str, Callable[[str, Any], Awaitable[Optional[dict]]]] = {
    "none": _provider_none, "nominatim": _provider_nominatim, "google": _provider_google,
}
_lookup = PROVIDERS[env.GEOCODING_PROVIDER]


def set_geocoder_for_tests(fn=None) -> None:
    global _lookup
    _lookup = fn or PROVIDERS[env.GEOCODING_PROVIDER]


# ---- Eircodes (Irish postcodes) ----
# Each Eircode belongs to one building, so a match is exact anywhere in Ireland: it is tried before the
# address text, and is not flagged approximate for lying outside the rider's service area.

_EIRCODE = re.compile(r"\b([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})\b", re.IGNORECASE)


def find_eircode(raw: str) -> Optional[str]:
    """The Eircode in an address, formatted "D01 F5P2", or None."""
    match = _EIRCODE.search(str(raw or ""))
    return f"{match.group(1)} {match.group(2)}".upper() if match else None


def _same_code(a: Any, b: str) -> bool:
    return re.sub(r"\s+", "", str(a or "")).upper() == b.replace(" ", "")


async def _eircode_google(code: str) -> Optional[dict]:
    for hit in await google_geocode({"address": f"{code}, Ireland", "components": "country:IE"}):
        # Google sometimes answers with just the routing area ("Dublin 1"); only a full match counts.
        if _same_code(_google_component(hit, "postal_code"), code):
            loc = hit["geometry"]["location"]
            return {"latitude": loc["lat"], "longitude": loc["lng"], "normalized": hit.get("formatted_address"), "approximate": False}
    return None


async def _eircode_nominatim(code: str) -> Optional[dict]:
    hits = await nominatim("search", {"postalcode": code, "countrycodes": "ie", "limit": "1"})
    hit = hits[0] if hits else None
    if not hit or not _same_code((hit.get("address") or {}).get("postcode"), code):
        return None
    return {"latitude": float(hit["lat"]), "longitude": float(hit["lon"]), "normalized": hit.get("display_name"), "approximate": False}


EIRCODE_PROVIDERS: dict[str, Callable[[str], Awaitable[Optional[dict]]]] = {
    "none": lambda code: _provider_none(code, None), "nominatim": _eircode_nominatim, "google": _eircode_google,
}
# Tests never call the network unless they swap a fake in.
_eircode_lookup = EIRCODE_PROVIDERS["none" if env.is_test else env.GEOCODING_PROVIDER]


def set_eircode_geocoder_for_tests(fn=None) -> None:
    global _eircode_lookup
    _eircode_lookup = fn or EIRCODE_PROVIDERS["none" if env.is_test else env.GEOCODING_PROVIDER]


async def geocode_eircode(code: str) -> Optional[dict]:
    """{latitude, longitude, normalized, approximate=False} for an exact Eircode match, else None (never raises)."""
    key = hashlib.sha1(f"v1|eircode|{code}".encode()).hexdigest()
    cached = await db.geocodecache.find_unique(where={"key": key})
    if cached and cached.expiresAt > now() and cached.found:
        return {"latitude": cached.latitude, "longitude": cached.longitude, "normalized": cached.normalized, "approximate": False}
    try:
        result = await _eircode_lookup(code)
    except Exception:  # noqa: BLE001 - the full address is tried next
        log(logging.WARNING, "Eircode lookup failed; trying the full address", exc_info=True)
        return None
    if result:
        data = {"found": True, "latitude": result["latitude"], "longitude": result["longitude"], "normalized": result.get("normalized"),
                "approximate": False, "provider": env.GEOCODING_PROVIDER, "expiresAt": now() + timedelta(days=180)}
        try:
            await db.geocodecache.upsert(where={"key": key}, data={"create": {"key": key, **data}, "update": data})
        except Exception:  # noqa: BLE001
            pass
    return result


# The same text means different places in different cities, so the rider's area is part of the key.
def _area_key(area: Any) -> str:
    if not area:
        return "anywhere"
    return f"{_area(area, 'countryCode')}:{_area(area, 'latitude'):.2f},{_area(area, 'longitude'):.2f}"


def cache_key(raw: str, area: Any) -> str:
    return hashlib.sha1(f"v2|{_area_key(area)}|{normalize_address(raw)}".encode()).hexdigest()


async def geocode_address(raw: str, *, retry_approximate: bool = False, area: Any = None) -> Optional[dict]:
    """Returns {latitude, longitude, normalized, approximate} or None. Provider errors are not cached.
    An Eircode in the address is looked up first; the full address only when that finds nothing."""
    code = find_eircode(raw)
    if code and (hit := await geocode_eircode(code)):
        return hit
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


# ---- Suggestions while typing, and the address at a dropped pin ----

SUGGEST_LIMIT = 5


def _suggestion(label: Any, latitude: float, longitude: float, area: Any, *, precise: bool) -> dict:
    point = {"latitude": latitude, "longitude": longitude}
    return {"label": str(label or ""), "latitude": latitude, "longitude": longitude,
            "approximate": not precise or not is_inside_area(point, area)}


async def _suggest_google(query: str, area: Any) -> list[dict]:
    """Places in the rider's city first (best for names like "railway station"), then street addresses.
    Matches outside the city are only offered when nothing inside it matched, and are flagged."""
    out: list[dict] = []
    if area:
        try:
            out += [{**p, "approximate": False} for p in await google_places(query, area, limit=SUGGEST_LIMIT)]
        except Exception:  # noqa: BLE001 - street address matches below still help
            log(logging.WARNING, "Places suggestions failed", exc_info=True)
    params = {"address": query}
    if area:
        min_lon, min_lat, max_lon, max_lat = area_box(area)
        params["bounds"] = f"{min_lat},{min_lon}|{max_lat},{max_lon}"
        if _area(area, "countryCode"):
            params["components"] = f"country:{_area(area, 'countryCode')}"
    addresses = []
    for hit in (await google_geocode(params))[:SUGGEST_LIMIT]:
        loc = hit["geometry"]["location"]
        addresses.append(_suggestion(hit.get("formatted_address"), loc["lat"], loc["lng"], area,
                                     precise=hit["geometry"].get("location_type") != "APPROXIMATE"))
    inside = [a for a in addresses if not a["approximate"]]
    return out + (inside if out or inside else addresses)


async def _suggest_nominatim(query: str, area: Any) -> list[dict]:
    params = {"q": query, "limit": str(SUGGEST_LIMIT)}
    if area and _area(area, "countryCode"):
        params["countrycodes"] = _area(area, "countryCode")

    def parse(hits: list) -> list[dict]:
        return [_suggestion(h.get("display_name"), float(h["lat"]), float(h["lon"]), area,
                            precise=str(h.get("addresstype") or "").lower() not in BROAD_ADDRESS_TYPES) for h in hits]

    if area:
        # Inside the rider's city first; the rest of the country only when the city has no match.
        inside = parse(await nominatim("search", {**params, "viewbox": ",".join(_js_number(n) for n in area_box(area)), "bounded": "1"}))
        if inside:
            return inside
    return parse(await nominatim("search", params))


async def _suggest_none(query: str, area: Any) -> list[dict]:
    return []


SUGGEST_PROVIDERS: dict[str, Callable[[str, Any], Awaitable[list[dict]]]] = {
    "none": _suggest_none, "nominatim": _suggest_nominatim, "google": _suggest_google,
}
_suggest = SUGGEST_PROVIDERS["none" if env.is_test else env.GEOCODING_PROVIDER]


def set_suggester_for_tests(fn=None) -> None:
    global _suggest
    _suggest = fn or SUGGEST_PROVIDERS["none" if env.is_test else env.GEOCODING_PROVIDER]


async def suggest_addresses(query: str, *, area: Any = None, near: Optional[dict] = None) -> list[dict]:
    """[{label, latitude, longitude, approximate}] for a street address, place name or postcode, closest to the rider first."""
    out: list[dict] = []
    code = find_eircode(query)
    if code and (hit := await geocode_eircode(code)):
        out.append({"label": hit.get("normalized") or code, "latitude": hit["latitude"], "longitude": hit["longitude"], "approximate": False})
    # Riders without a saved city still get results around where they are.
    area = area or ({"latitude": near["latitude"], "longitude": near["longitude"], "countryCode": None} if near else None)
    try:
        out += await _suggest(query, area)
    except Exception:  # noqa: BLE001
        log(logging.WARNING, "Address suggestions failed", exc_info=True)
        raise AppError(503, "GEOCODING_UNAVAILABLE", "Address search is temporarily unavailable. Check your connection and try again.") from None
    unique = list({(round(s["latitude"], 5), round(s["longitude"], 5)): s for s in reversed(out)}.values())[::-1]
    # Matches in the rider's city first; otherwise keep the provider's relevance order.
    unique.sort(key=lambda s: s["approximate"])
    return unique[:SUGGEST_LIMIT]


async def reverse_geocode(latitude: float, longitude: float) -> Optional[str]:
    """The street address at a point, or None when the provider has none (never raises)."""
    try:
        if env.is_test or env.GEOCODING_PROVIDER == "none":
            return None
        if env.GEOCODING_PROVIDER == "google":
            results = await google_geocode({"latlng": f"{latitude},{longitude}"})
            return results[0].get("formatted_address") if results else None
        hit = await nominatim("reverse", {"lat": _js_number(latitude), "lon": _js_number(longitude), "zoom": "18"})
        return (hit or {}).get("display_name")
    except Exception:  # noqa: BLE001 - the rider can still type the address for the pin
        log(logging.WARNING, "Reverse geocoding failed", exc_info=True)
        return None


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
    if env.GEOCODING_PROVIDER == "google":
        results = await google_geocode({"latlng": f"{latitude},{longitude}"})
        return _google_area(results[0], latitude, longitude) if results else None
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
    if env.GEOCODING_PROVIDER == "google":
        try:
            results = await google_geocode({"address": query})
        except Exception:  # noqa: BLE001
            log(logging.WARNING, "Service area search failed", exc_info=True)
            raise AppError(503, "GEOCODING_UNAVAILABLE", "Could not look up that city right now. Check your connection and try again.") from None
        if not results:
            return None
        loc = results[0]["geometry"]["location"]
        return _google_area(results[0], loc["lat"], loc["lng"])
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
