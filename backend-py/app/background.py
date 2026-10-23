"""Fire-and-forget work that must not hold up (or leak through) the response, like sending email."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable

from .logger import log

_tasks: set[asyncio.Task] = set()


def spawn(work: Awaitable[None], what: str) -> None:
    async def run() -> None:
        try:
            await work
        except Exception:  # noqa: BLE001 - a background failure is logged, never raised into a request
            log(logging.ERROR, f"Background task failed: {what}", exc_info=True)

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def wait_all() -> None:
    """Tests use this to let queued work finish before asserting on it (including the emails the worker sends)."""
    from .services import jobs

    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
    await jobs.wait_idle(("send_email", "password_reset_code"))
