from __future__ import annotations

from typing import Any


class AppError(Exception):
    """An error with an HTTP status and a stable machine-readable code for clients."""

    def __init__(self, status: int, code: str, message: str, details: list[Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details if details is not None else []


def bad_request(message: str, details: list[Any] | None = None) -> AppError:
    return AppError(400, "BAD_REQUEST", message, details)


def validation_error(details: list[Any], message: str = "Validation failed") -> AppError:
    return AppError(400, "VALIDATION_ERROR", message, details)


def unauthorized(message: str = "Authentication required", code: str = "UNAUTHORIZED") -> AppError:
    return AppError(401, code, message)


def forbidden(message: str = "You do not have permission to do this", code: str = "FORBIDDEN") -> AppError:
    return AppError(403, code, message)


def not_found(what: str = "Resource") -> AppError:
    return AppError(404, "NOT_FOUND", f"{what} not found")


def conflict(message: str, code: str = "CONFLICT", details: list[Any] | None = None) -> AppError:
    return AppError(409, code, message, details)


def unprocessable(message: str, code: str = "UNPROCESSABLE", details: list[Any] | None = None) -> AppError:
    return AppError(422, code, message, details)


def error_body(code: str, message: str, details: list[Any] | None = None) -> dict:
    return {"success": False, "error": {"code": code, "message": message, "details": details or []}}
