"""Local-disk file storage. Swap these functions for an S3/GCS client to use object storage; callers only see keys."""
from __future__ import annotations

import asyncio
import os
import re
import uuid
from pathlib import Path

from ..config import BASE_DIR, env
from ..errors import not_found

KEY_RE = re.compile(r"^(proofs|reports)/[0-9a-f-]{36}\.(jpg|png|pdf)$")


def root() -> Path:
    path = Path(env.STORAGE_DIR)
    return (path if path.is_absolute() else BASE_DIR / path).resolve()


def resolve_key(key: str) -> Path:
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise not_found("File")
    base = root()
    full = (base / key).resolve()
    if base not in full.parents:
        raise not_found("File")
    return full


def _write(full: Path, data: bytes) -> None:
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)
    try:
        os.chmod(full, 0o640)
    except OSError:
        pass


async def save(data: bytes, kind: str, ext: str) -> str:
    key = f"{kind}/{uuid.uuid4()}.{ext}"
    await asyncio.to_thread(_write, resolve_key(key), data)
    return key


async def read(key: str) -> bytes:
    full = resolve_key(key)
    try:
        return await asyncio.to_thread(full.read_bytes)
    except FileNotFoundError:
        raise not_found("File") from None


def stat(key: str) -> os.stat_result:
    try:
        return resolve_key(key).stat()
    except FileNotFoundError:
        raise not_found("File") from None


async def remove(key: str | None) -> None:
    if not key:
        return
    try:
        await asyncio.to_thread(resolve_key(key).unlink)
    except Exception:  # noqa: BLE001 - already gone
        pass


def content_type_for(key: str) -> str:
    return {"jpg": "image/jpeg", "png": "image/png", "pdf": "application/pdf"}.get(key.rsplit(".", 1)[-1], "application/octet-stream")
