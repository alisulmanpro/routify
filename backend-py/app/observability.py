"""Error reporting (P0.8): Sentry for the API and the worker, on only when SENTRY_DSN is set.

No personal data is sent (no IPs, cookies, headers or request bodies); errors carry the request id from the access log,
so a Sentry event can be matched to its log line."""
from __future__ import annotations

from .config import env


def init_sentry(component: str) -> bool:
    if not env.SENTRY_DSN or env.is_test:
        return False
    import sentry_sdk

    sentry_sdk.init(dsn=env.SENTRY_DSN, environment=env.NODE_ENV, server_name=component, send_default_pii=False,
                    traces_sample_rate=env.SENTRY_TRACES_SAMPLE_RATE, max_request_body_size="never")
    sentry_sdk.set_tag("component", component)
    return True
