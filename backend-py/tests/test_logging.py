"""The start command (python -m app / start.sh) and the two log formats."""
from __future__ import annotations

import json
import logging
import logging.config

from app import __main__ as start
from app.logger import _JsonFormatter, _PrettyFormatter, uvicorn_log_config


def _record(msg: str, name: str = "routify", **ctx) -> logging.LogRecord:
    record = logging.LogRecord(name, logging.WARNING, __file__, 1, msg, None, None)
    record.ctx = ctx
    return record


def test_pretty_request_line():
    line = _PrettyFormatter(color=False).format(_record("request completed", reqId="r1", method="GET", url="/api/v1/auth/me",
                                                        statusCode=401, responseTime=4, dbQueries=3, dbMs=2.5))
    assert line.endswith("WARN  GET /api/v1/auth/me 401 4ms · 3 queries 2.5ms  reqId=r1")


def test_pretty_other_lines_keep_their_fields_and_source():
    line = _PrettyFormatter(color=False).format(_record("Job failed", job="plan", error="no route found"))
    assert line.endswith('WARN  Job failed  job=plan error="no route found"')
    assert "[uvicorn] Shutting down" in _PrettyFormatter(color=False).format(_record("Shutting down", name="uvicorn.error"))


def test_json_lines_are_unchanged():
    entry = json.loads(_JsonFormatter().format(_record("request completed", statusCode=200)))
    assert entry["level"] == "warning" and entry["msg"] == "request completed" and entry["statusCode"] == 200


def test_uvicorn_log_config_is_valid_and_keeps_its_access_log_off():
    logging.config.dictConfig(uvicorn_log_config())
    assert logging.getLogger("uvicorn.access").handlers == []
    assert not logging.getLogger("uvicorn.access").propagate


def test_start_options_default_to_the_environment():
    args = start.parse_args([])
    assert args.port == start.env.PORT and args.host == "0.0.0.0"
    args = start.parse_args(["--port", "5000", "--no-reload", "--workers", "3"])
    assert (args.port, args.reload, args.workers) == (5000, False, 3)
