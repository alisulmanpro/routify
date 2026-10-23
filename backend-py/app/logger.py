from __future__ import annotations

import atexit
import json
import logging
import os
import sys
import threading
import time
from collections import deque
from typing import ClassVar

from .config import env

_LEVELS = {"fatal": logging.CRITICAL, "error": logging.ERROR, "warn": logging.WARNING, "info": logging.INFO, "debug": logging.DEBUG, "trace": logging.DEBUG}


class _JsonFormatter(logging.Formatter):
    """One JSON object per line, like the pino logs the Node API wrote."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {"level": record.levelname.lower(), "time": int(time.time() * 1000), "msg": record.getMessage()}
        extra = getattr(record, "ctx", None)
        if isinstance(extra, dict):
            entry.update(extra)
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class _PrettyFormatter(logging.Formatter):
    """LOG_FORMAT=pretty: one readable line per entry for a terminal, coloured when it is one (NO_COLOR turns that off).

        10:41:02.118 INFO  GET /api/v1/auth/me 200 12ms · 3 queries 4.1ms  reqId=1b6c…
        10:41:05.402 WARN  Could not save request metrics  instance=host:123
    """

    _COLORS: ClassVar = {"DEBUG": "\x1b[2m", "INFO": "\x1b[32m", "WARNING": "\x1b[33m", "ERROR": "\x1b[31m", "CRITICAL": "\x1b[1;31m"}
    _NAMES: ClassVar = {"WARNING": "WARN", "CRITICAL": "FATAL"}
    _DIM, _RESET = "\x1b[2m", "\x1b[0m"

    def __init__(self, color: bool):
        super().__init__()
        self.color = color

    def _paint(self, code: str, text: str) -> str:
        return f"{code}{text}{self._RESET}" if self.color else text

    @staticmethod
    def _value(value) -> str:
        text = value if isinstance(value, str) else json.dumps(value, default=str)
        return json.dumps(text) if not text or any(c.isspace() for c in text) else text

    def format(self, record: logging.LogRecord) -> str:
        ctx = dict(getattr(record, "ctx", None) or {})
        stamp = time.strftime("%H:%M:%S", time.localtime(record.created)) + f".{int(record.msecs):03d}"
        level = self._NAMES.get(record.levelname, record.levelname)
        msg = record.getMessage()
        if msg == "request completed" and "statusCode" in ctx:
            msg = f"{ctx.pop('method', '')} {ctx.pop('url', '')} {ctx.pop('statusCode')} {ctx.pop('responseTime', '?')}ms"
            queries, db_ms = ctx.pop("dbQueries", 0), ctx.pop("dbMs", 0)
            if queries:
                msg += self._paint(self._DIM, f" · {queries} quer{'y' if queries == 1 else 'ies'} {db_ms}ms")
        elif not record.name.startswith("routify"):
            msg = self._paint(self._DIM, f"[{record.name.split('.')[0]}] ") + msg
        line = f"{self._paint(self._DIM, stamp)} {self._paint(self._COLORS.get(record.levelname, ''), f'{level:<5}')} {msg}"
        if ctx:
            line += "  " + self._paint(self._DIM, " ".join(f"{key}={self._value(value)}" for key, value in ctx.items()))
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def _formatter() -> logging.Formatter:
    if env.LOG_FORMAT == "pretty":
        return _PrettyFormatter(color=sys.stdout.isatty() and not os.environ.get("NO_COLOR"))
    return _JsonFormatter()


def stdout_handler() -> logging.Handler:
    """The stdout handler in the chosen LOG_FORMAT (also used for uvicorn's own loggers, see uvicorn_log_config)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_formatter())
    return handler


def uvicorn_log_config() -> dict:
    """uvicorn's log_config: its startup/shutdown and server-error lines in the same format as ours. Its access log
    stays off; EdgeMiddleware writes a richer one ("request completed": status, time, database queries)."""
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "handlers": {"stdout": {"()": "app.logger.stdout_handler"}},
        "loggers": {
            "uvicorn": {"handlers": ["stdout"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"level": "INFO"},
            "uvicorn.access": {"handlers": [], "level": "WARNING", "propagate": False},
        },
    }


class _ShipHandler(logging.Handler):
    """Log shipping (P7.6): the same JSON lines, POSTed in batches to LOG_SHIP_URL (e.g. a Better Stack / Logtail HTTP
    source) from a background thread, every SHIP_EVERY s or SHIP_BATCH lines. Logging never waits on it; when the
    service is unreachable the oldest lines are dropped beyond SHIP_BUFFER, and stdout still has them all."""

    SHIP_EVERY = 2.0
    SHIP_BATCH = 500
    SHIP_BUFFER = 20_000

    def __init__(self, url: str, token: str):
        super().__init__()
        self.url, self.token = url, token
        self.lines: deque[str] = deque(maxlen=self.SHIP_BUFFER)
        self.wake = threading.Event()
        threading.Thread(target=self._loop, name="log-ship", daemon=True).start()
        atexit.register(self._send_all)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
            if len(self.lines) >= self.SHIP_BATCH:
                self.wake.set()
        except Exception:  # noqa: BLE001 - logging must never raise
            self.handleError(record)

    def _loop(self) -> None:
        while True:
            self.wake.wait(self.SHIP_EVERY)
            self.wake.clear()
            self._send_all()

    def _send_all(self) -> None:
        import httpx

        while self.lines:
            batch: list[str] = []
            while len(batch) < self.SHIP_BATCH:
                try:
                    batch.append(self.lines.popleft())
                except IndexError:  # emptied (the exit flush runs on another thread)
                    break
            if not batch:
                return
            try:
                httpx.post(self.url, content="[" + ",".join(batch) + "]", timeout=10,
                           headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {self.token}"} if self.token else {})})
            except Exception:  # noqa: BLE001 - the lines are on stdout too
                return


logger = logging.getLogger("routify")
logger.addHandler(stdout_handler())
if env.LOG_SHIP_URL and not env.is_test:
    _shipper = _ShipHandler(env.LOG_SHIP_URL, env.LOG_SHIP_TOKEN)
    _shipper.setFormatter(_JsonFormatter())  # always JSON: log services parse it
    logger.addHandler(_shipper)
logger.propagate = False
logger.setLevel(logging.CRITICAL + 10 if env.is_test else _LEVELS.get(env.LOG_LEVEL, logging.INFO))


def log(level: int, msg: str, **ctx) -> None:
    logger.log(level, msg, extra={"ctx": ctx}, exc_info=ctx.pop("exc_info", None))
