"""Per-request timing (P0.7): total time, database round trips and time spent in them.

EdgeMiddleware opens a RequestStats for each request; every round trip to the Prisma query engine (a query, a batch,
a transaction start/commit/rollback) made while handling it is counted there. The numbers go into the access log and
the `Server-Timing` response header (visible in browser dev tools and to the load tests):

    Server-Timing: app;dur=41.2, db;dur=12.7;desc="5 queries"
"""
from __future__ import annotations

import time
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class RequestStats:
    started: float
    db_queries: int = 0
    db_ms: float = 0.0

    def elapsed_ms(self) -> float:
        return (time.perf_counter() - self.started) * 1000

    def server_timing(self) -> str:
        return f'app;dur={self.elapsed_ms():.1f}, db;dur={self.db_ms:.1f};desc="{self.db_queries} queries"'


current_stats: ContextVar[RequestStats | None] = ContextVar("current_stats", default=None)
_installed = False


def install() -> None:
    """Wraps the query engine's round-trip methods once per process (cheap: one ContextVar read when nothing is timed)."""
    global _installed
    if _installed:
        return
    from prisma.engine._query import AsyncQueryEngine

    def wrap(name: str) -> None:
        original = getattr(AsyncQueryEngine, name)

        async def timed(engine, *args, **kwargs):
            stats = current_stats.get()
            if stats is None:
                return await original(engine, *args, **kwargs)
            started = time.perf_counter()
            try:
                return await original(engine, *args, **kwargs)
            finally:
                stats.db_queries += 1
                stats.db_ms += (time.perf_counter() - started) * 1000

        setattr(AsyncQueryEngine, name, timed)

    for name in ("query", "start_transaction", "commit_transaction", "rollback_transaction"):
        wrap(name)
    _installed = True
