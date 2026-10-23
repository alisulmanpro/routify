from __future__ import annotations

import atexit
import json
import logging
import sys
import threading
import time
from collections import deque

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
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_JsonFormatter())
logger.addHandler(_handler)
if env.LOG_SHIP_URL and not env.is_test:
    _shipper = _ShipHandler(env.LOG_SHIP_URL, env.LOG_SHIP_TOKEN)
    _shipper.setFormatter(_JsonFormatter())
    logger.addHandler(_shipper)
logger.propagate = False
logger.setLevel(logging.CRITICAL + 10 if env.is_test else _LEVELS.get(env.LOG_LEVEL, logging.INFO))


def log(level: int, msg: str, **ctx) -> None:
    logger.log(level, msg, extra={"ctx": ctx}, exc_info=ctx.pop("exc_info", None))
