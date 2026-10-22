"""The worker process (P6b.2): runs background jobs (route optimisation, large plans) so the API process never does.

    python -m app.worker

Several can run at once (each job is claimed once). SIGTERM/SIGINT: finishes the job in hand, then exits.
"""
from __future__ import annotations

import asyncio
import logging
import signal

from .db import connect, disconnect
from .logger import log
from .services import jobs

# Importing these registers their job handlers (plan, optimize_route).
from .services import optimizer as _optimizer  # noqa: F401
from .services import route_service as _route_service  # noqa: F401

IDLE_POLL_SECONDS = 0.5
STALE_CHECK_SECONDS = 60.0


async def run(stop: asyncio.Event, *, poll: float = IDLE_POLL_SECONDS) -> None:
    """Runs jobs until `stop` is set (the API's tests run this in-process with a short poll)."""
    loop = asyncio.get_running_loop()
    next_stale_check = 0.0
    while not stop.is_set():
        if loop.time() >= next_stale_check:
            await jobs.requeue_stale()
            next_stale_check = loop.time() + STALE_CHECK_SECONDS
        try:
            worked = await jobs.run_one()
        except Exception:  # noqa: BLE001 - a database hiccup must not stop the worker
            log(logging.ERROR, "Worker could not take a job", exc_info=True)
            worked = False
        if not worked:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass


async def main() -> None:
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await connect()
    log(logging.INFO, "Worker started")
    try:
        await run(stop)
    finally:
        await disconnect()
        log(logging.INFO, "Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
