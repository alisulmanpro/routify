"""Response envelope, pagination and number helpers shared by every endpoint."""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

from starlette.responses import JSONResponse


def ok(data: Any, meta: Any = None) -> dict:
    return {"success": True, "data": data, "meta": meta} if meta else {"success": True, "data": data}


def paginate(q: dict) -> tuple[int, int, int]:
    page = max(1, int(q.get("page") or 1))
    limit = min(100, max(1, int(q.get("limit") or 20)))
    return page, limit, (page - 1) * limit


def page_meta(page: int, limit: int, total: int) -> dict:
    return {"page": page, "limit": limit, "total": total, "pages": max(1, math.ceil(total / limit))}


def now() -> datetime:
    return datetime.now(timezone.utc)


def today_key(at: datetime | None = None) -> str:
    return (at or now()).astimezone(timezone.utc).strftime("%Y-%m-%d")


def js_round(n: float) -> int:
    """JavaScript Math.round: halves round up (Python's round() rounds halves to even)."""
    return math.floor(n + 0.5)


def round2(n: float) -> float:
    value = math.floor((float(n) + 2.220446049250313e-16) * 100 + 0.5) / 100
    return int(value) if value.is_integer() else value


def iso(value: datetime | None) -> str | None:
    """Dates are sent exactly as the Node API sent them: 2026-01-31T09:15:00.000Z."""
    if value is None:
        return None
    value = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _default(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (set, tuple)):
        return list(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _clean(value: Any) -> Any:
    # Whole floats are sent as integers (12 rather than 12.0) to match the JSON the Node API produced.
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return int(value)
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    return value


def dumps(content: Any) -> bytes:
    return json.dumps(_clean(content), default=_default, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class ApiJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return dumps(content)


def respond(data: Any, status: int = 200, meta: Any = None, headers: dict | None = None) -> ApiJSONResponse:
    return ApiJSONResponse(ok(data, meta), status_code=status, headers=headers)
