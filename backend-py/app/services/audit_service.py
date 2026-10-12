from __future__ import annotations

import logging
from typing import Any

from ..db import as_json, db
from ..ids import new_id
from ..logger import log


async def audit(actor: dict | None, action: str, *, target_type: str | None = None, target_id: Any = None,
                status: str = "success", meta: Any = None, ip: str | None = None) -> None:
    """Never raises: auditing must not break the request it describes."""
    try:
        data: dict[str, Any] = {
            "id": new_id(), "actorId": (actor or {}).get("id") or None, "actorEmail": (actor or {}).get("email") or None,
            "action": action, "targetType": target_type, "targetId": str(target_id) if target_id else None,
            "status": status, "ip": ip,
        }
        if meta is not None:
            data["meta"] = as_json(meta)
        await db.auditlog.create(data=data)
    except Exception:  # noqa: BLE001
        log(logging.ERROR, "Failed to write audit log", action=action, exc_info=True)
