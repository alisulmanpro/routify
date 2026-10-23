"""File storage for proof photos and report PDFs (P7.1). Callers only see keys ("proofs/<uuid>.jpg").

STORAGE_BACKEND=local: files under STORAGE_DIR (development; a container's disk is lost on restart).
STORAGE_BACKEND=s3: an S3-compatible bucket (Cloudflare R2 in production), via app/services/s3.py.
Old local files are copied to the bucket with scripts/migrate_files_to_s3.py.
"""
from __future__ import annotations

import asyncio
import os
import re
import uuid
from pathlib import Path

from starlette.responses import FileResponse, RedirectResponse, Response

from ..config import BASE_DIR, env
from ..errors import not_found
from . import s3

KEY_RE = re.compile(r"^(proofs|reports)/[0-9a-f-]{36}\.(jpg|png|pdf)$")
# How long a presigned link to a file in the bucket works: the API's own signed link has already been checked.
PRESIGNED_SECONDS = 300


def uses_s3() -> bool:
    return env.STORAGE_BACKEND == "s3"


def root() -> Path:
    path = Path(env.STORAGE_DIR)
    return (path if path.is_absolute() else BASE_DIR / path).resolve()


def check_key(key: str) -> str:
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise not_found("File")
    return key


def resolve_key(key: str) -> Path:
    """The local path of a key (local backend, and the migration script reading old files)."""
    base = root()
    full = (base / check_key(key)).resolve()
    if base not in full.parents:
        raise not_found("File")
    return full


def content_type_for(key: str) -> str:
    return {"jpg": "image/jpeg", "png": "image/png", "pdf": "application/pdf"}.get(key.rsplit(".", 1)[-1], "application/octet-stream")


def _write(full: Path, data: bytes) -> None:
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)
    try:
        os.chmod(full, 0o640)
    except OSError:
        pass


async def save(data: bytes, kind: str, ext: str) -> str:
    key = check_key(f"{kind}/{uuid.uuid4()}.{ext}")
    if uses_s3():
        await s3.put(key, data, content_type_for(key))
    else:
        await asyncio.to_thread(_write, resolve_key(key), data)
    return key


async def read(key: str) -> bytes:
    if uses_s3():
        data = await s3.get(check_key(key))
        if data is None:
            raise not_found("File")
        return data
    full = resolve_key(key)
    try:
        return await asyncio.to_thread(full.read_bytes)
    except FileNotFoundError:
        raise not_found("File") from None


async def remove(key: str | None) -> None:
    if not key:
        return
    try:
        if uses_s3():
            await s3.delete(check_key(key))
        else:
            await asyncio.to_thread(resolve_key(key).unlink)
    except Exception:  # noqa: BLE001, S110 - already gone, or a stray key: nothing to keep
        pass


async def file_response(key: str, disposition: str, name: str, headers: dict[str, str]) -> Response:
    """The answer to a checked, signed /files link: the file itself (local), or a short-lived link to it in the bucket."""
    content_type = content_type_for(check_key(key))
    if uses_s3():
        url = s3.presigned_get(key, PRESIGNED_SECONDS, content_type=content_type, disposition=f'{disposition}; filename="{name}"')
        return RedirectResponse(url, status_code=307, headers={k: v for k, v in headers.items() if k != "Content-Disposition"})
    full = resolve_key(key)
    try:
        info = full.stat()
    except FileNotFoundError:
        raise not_found("File") from None
    return FileResponse(full, media_type=content_type, stat_result=info, headers=headers)
