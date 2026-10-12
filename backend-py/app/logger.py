from __future__ import annotations

import json
import logging
import sys
import time

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


logger = logging.getLogger("routify")
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_JsonFormatter())
logger.addHandler(_handler)
logger.propagate = False
logger.setLevel(logging.CRITICAL + 10 if env.is_test else _LEVELS.get(env.LOG_LEVEL, logging.INFO))


def log(level: int, msg: str, **ctx) -> None:
    logger.log(level, msg, extra={"ctx": ctx}, exc_info=ctx.pop("exc_info", None))
