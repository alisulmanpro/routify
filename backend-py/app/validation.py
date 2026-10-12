"""Request validation with the same semantics and error envelope as the Node API's zod `validate()` middleware.

Bodies, queries and path params are parsed manually (after authentication, like Express did), so
a request missing a body is treated as `{}` and unknown fields are silently dropped.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date
from typing import Annotated, Any, ClassVar, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator
from starlette.requests import Request

from .errors import AppError, validation_error
from .ids import OBJECT_ID_RE

MAX_JSON_BYTES = 1024 * 1024


class Schema(BaseModel):
    model_config = ConfigDict(extra="ignore")
    # zod's .optional() rejects null; only fields listed here (zod .nullable()/.nullish()) accept it.
    nullable_fields: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def _reject_null(self):
        for name in self.model_fields_set:
            if getattr(self, name) is None and name not in self.nullable_fields:
                raise ValueError(f"{name}: Expected a value, received null")
        return self

    def provided(self) -> dict:
        """Only the keys the client actually sent (zod omits absent optional keys)."""
        return self.model_dump(exclude_unset=True)


# ---- reusable field types ----

def _object_id(v: str) -> str:
    if not OBJECT_ID_RE.match(v):
        raise ValueError("Invalid id")
    return v


def _date_key(v: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise ValueError("Use YYYY-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise ValueError("Invalid date") from None
    return v


def _phone(v: str) -> str:
    if not re.fullmatch(r"\+?[\d\s\-()]{5,}", v):
        raise ValueError("Enter a valid phone number")
    return v


_EMAIL_RE = re.compile(r"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+\-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$")


def _email(v: str) -> str:
    if not _EMAIL_RE.match(v):
        raise ValueError("Invalid email address")
    return v


def _finite(v: float) -> float:
    if not math.isfinite(v):
        raise ValueError("Number must be finite")
    return v


def Trimmed(lo: int, hi: int):  # noqa: N802 - reads like a type
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=lo, max_length=hi)]


ObjectId = Annotated[str, AfterValidator(_object_id)]
DateKey = Annotated[str, AfterValidator(_date_key)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, min_length=5, max_length=32), AfterValidator(_phone)]
Email = Annotated[str, StringConstraints(max_length=254), AfterValidator(_email)]
Money = Annotated[float, Field(ge=0, le=1_000_000_000), AfterValidator(_finite)]
Currency = Literal["USD", "GBP", "EUR", "PKR", "INR"]
Preference = Literal["smart", "nearest_first", "shortest"]
OptionalText = lambda hi: Optional[Annotated[str, StringConstraints(strip_whitespace=True, max_length=hi)]]  # noqa: E731


class IdParams(Schema):
    id: ObjectId


class Pagination(Schema):
    page: Optional[Annotated[int, Field(ge=1)]] = None
    limit: Optional[Annotated[int, Field(ge=1, le=100)]] = None


# ---- parsing ----

_LOCATION = {"params": "params", "query": "query", "body": "body"}


def _issues(part: str, error: ValidationError) -> list[dict]:
    out = []
    for e in error.errors():
        path = ".".join(str(p) for p in e.get("loc", ()) if p != "__root__")
        message = e.get("msg", "Invalid value")
        if message.startswith("Value error, "):
            message = message[len("Value error, "):]
        if e.get("type") == "missing":
            message = "Required"
        out.append({"location": part, "path": path, "message": message})
    return out


async def read_json(request: Request) -> Any:
    """express.json(): only JSON requests have a body; anything else is treated as no body."""
    content_type = request.headers.get("content-type", "")
    if "json" not in content_type.lower():
        return None
    raw = await request.body()
    if len(raw) > MAX_JSON_BYTES:
        raise AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large")
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise AppError(400, "BAD_REQUEST", "Request body is not valid JSON") from None


async def validate(request: Request, *, params: type[Schema] | None = None, query: type[Schema] | None = None,
                   body: type[Schema] | None = None, body_default: Any = None) -> dict[str, Any]:
    """Validates every requested part and reports all issues at once, like the zod middleware."""
    valid: dict[str, Any] = {}
    issues: list[dict] = []
    sources: list[tuple[str, type[Schema], Any]] = []
    if params:
        sources.append(("params", params, dict(request.path_params)))
    if query:
        sources.append(("query", query, dict(request.query_params)))
    if body:
        payload = await read_json(request)
        sources.append(("body", body, payload if payload is not None else (body_default if body_default is not None else {})))
    for part, schema, data in sources:
        try:
            if not isinstance(data, dict):
                raise ValueError
            valid[part] = schema.model_validate(data)
        except ValidationError as error:
            issues.extend(_issues(part, error))
        except ValueError:
            issues.append({"location": part, "path": "", "message": "Expected object"})
    if issues:
        raise validation_error(issues)
    return valid


def nothing_to_update(model: Schema) -> Schema:
    """`.refine((b) => Object.keys(b).length, 'Nothing to update')`"""
    if not model.model_fields_set:
        raise ValueError("Nothing to update")
    return model
