from __future__ import annotations

import math
import re

R = 6371


def _get(p, name: str):
    return p[name] if isinstance(p, dict) else getattr(p, name)


def haversine_km(a, b) -> float:
    lat1, lon1, lat2, lon2 = _get(a, "latitude"), _get(a, "longitude"), _get(b, "latitude"), _get(b, "longitude")
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    h = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))


_NON_WORD = re.compile(r"[^\w\s]|_", re.UNICODE)


def normalize_address(raw) -> str:
    """Lower-case, letters/digits only, single spaces (Unicode aware, like /[^\\p{L}\\p{N}\\s]/gu)."""
    text = _NON_WORD.sub(" ", str(raw or "").lower())
    return re.sub(r"\s+", " ", text).strip()
