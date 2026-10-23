"""Multipart uploads with the same limits, field names and error codes as the Node API's multer setup."""
from __future__ import annotations

from dataclasses import dataclass

from starlette.datastructures import UploadFile
from starlette.requests import Request

from .errors import AppError, unprocessable

MB = 1024 * 1024


@dataclass
class UploadedFile:
    data: bytes
    filename: str
    content_type: str


@dataclass(frozen=True)
class UploadSpec:
    field: str
    max_bytes: int
    mimes: tuple[str, ...]
    extensions: tuple[str, ...] = ()


PHOTO = UploadSpec("photo", 8 * MB, ("image/jpeg", "image/jpg", "image/png"), ("jpg", "jpeg", "png"))
PDF = UploadSpec("file", 10 * MB, ("application/pdf",), ("pdf",))
DOCUMENT = UploadSpec("file", 10 * MB, (
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "text/plain",
), ("pdf", "docx", "doc", "xlsx", "xls", "csv", "txt"))


def _ext(name: str | None) -> str:
    return (name or "").rsplit(".", 1)[-1].lower() if "." in (name or "") else (name or "").lower()


async def receive(request: Request, spec: UploadSpec) -> UploadedFile | None:
    """Returns the single uploaded file (or None when the request carries none)."""
    if "multipart/form-data" not in request.headers.get("content-type", "").lower():
        return None
    try:
        form = await request.form(max_files=10, max_fields=20)
    except AppError:
        raise
    except Exception as error:  # noqa: BLE001
        raise AppError(400, "UPLOAD_ERROR", str(error) or "Malformed multipart body") from None

    found: UploadedFile | None = None
    try:
        for name, value in form.multi_items():
            if not isinstance(value, UploadFile):
                continue
            if name != spec.field:
                raise AppError(400, "UPLOAD_ERROR", "Unexpected field")
            if found is not None:
                raise AppError(400, "UPLOAD_ERROR", "Too many files")
            mime = (value.content_type or "").lower()
            ext = _ext(value.filename)
            accepts = mime in spec.mimes or (ext and ext in spec.extensions) or (mime == "image/jpg" and ext in ("jpg", "jpeg"))
            if not accepts:
                raise AppError(415, "UNSUPPORTED_MEDIA_TYPE", f"Only {', '.join(spec.mimes)} files are accepted")
            data = await value.read(spec.max_bytes + 1)
            if len(data) > spec.max_bytes:
                raise AppError(413, "FILE_TOO_LARGE", "The uploaded file is too large")
            found = UploadedFile(data=data, filename=value.filename or "", content_type=mime)
    finally:
        await form.close()
    return found


_SIGNATURES = {
    "jpg": lambda b: b[:3] == b"\xff\xd8\xff",
    "jpeg": lambda b: b[:3] == b"\xff\xd8\xff",
    "png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n",
    "pdf": lambda b: b[:5] == b"%PDF-",
}


def detect_file_type(data: bytes | None, allowed: list[str]) -> str:
    """Never trust the client's mimetype: verify the magic bytes and return the canonical extension."""
    if not data:
        raise unprocessable("No file was uploaded", "FILE_REQUIRED")
    kind = next((ext for ext in allowed if _SIGNATURES[ext](data)), None)
    if not kind:
        raise AppError(415, "INVALID_FILE", "The uploaded file content does not match an allowed type")
    return kind


def detect_document_type(data: bytes | None, filename: str | None) -> str:
    """Detects the document type from the extension plus a basic content check."""
    if not data:
        raise unprocessable("No file was uploaded", "FILE_REQUIRED")
    ext = _ext(filename) if filename and "." in filename else ""
    if ext not in ("pdf", "docx", "doc", "xlsx", "xls", "csv", "txt"):
        raise AppError(415, "UNSUPPORTED_FILE", "Unsupported file type")
    if ext == "pdf" and data[:5] != b"%PDF-":
        raise AppError(415, "INVALID_FILE", "File does not appear to be a valid PDF")
    if ext in ("docx", "xlsx") and data[:2] != b"PK":
        raise AppError(415, "INVALID_FILE", "File does not appear to be a valid Office document")
    if ext in ("doc", "xls") and data[:2] != b"\xd0\xcf":
        raise AppError(415, "INVALID_FILE", "File does not appear to be a valid Office document")
    if ext == "txt" and b"\x00" in data[:4096]:
        raise AppError(415, "INVALID_FILE", "File does not appear to be a plain text file")
    return ext
