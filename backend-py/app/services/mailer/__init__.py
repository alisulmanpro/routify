"""Provider-neutral email sending.

Pick the provider with EMAIL_PROVIDER (see .env.example). SMTP works with practically every email service;
the HTTP providers use the service's own API. To add another service, subclass `Mailer` (or `HttpMailer`
for a JSON API) in providers.py and add it to PROVIDERS plus `config.EMAIL_PROVIDERS`.
"""
from __future__ import annotations

import dataclasses

from ...background import spawn
from ...config import env
from .. import jobs
from .base import EmailError, EmailMessage, Mailer, Sender
from .providers import BrevoMailer, ConsoleMailer, DisabledMailer, MailgunMailer, PostmarkMailer, ResendMailer, SendGridMailer, SmtpMailer

PROVIDERS: dict[str, type[Mailer]] = {
    "console": ConsoleMailer,
    "disabled": DisabledMailer,
    "smtp": SmtpMailer,
    "brevo": BrevoMailer,
    "sendgrid": SendGridMailer,
    "resend": ResendMailer,
    "mailgun": MailgunMailer,
    "postmark": PostmarkMailer,
}

_mailer: Mailer | None = None
_override: Mailer | None = None


def get_mailer() -> Mailer:
    global _mailer
    if _override is not None:
        return _override
    if _mailer is None:
        sender = Sender(email=env.EMAIL_FROM or "no-reply@localhost", name=env.EMAIL_FROM_NAME, reply_to=env.EMAIL_REPLY_TO)
        _mailer = PROVIDERS[env.EMAIL_PROVIDER](sender)
    return _mailer


def set_mailer_for_tests(mailer: Mailer | None = None) -> None:
    global _override
    _override = mailer


async def send_email(message: EmailMessage) -> None:
    """Sends now and raises EmailError on failure."""
    await get_mailer().send(message)


def send_in_background(message: EmailMessage) -> None:
    """Fire-and-forget: the request does not wait for (or reveal) the delivery result. The worker sends it (P7.3) and
    tries again later if the provider fails, so a restart or a provider hiccup does not lose the email."""
    spawn(jobs.enqueue("send_email", dataclasses.asdict(message)), "queue email")


@jobs.handler("send_email", retries=2)
async def _send_email_job(payload: dict) -> None:
    await send_email(EmailMessage(**payload))


__all__ = ["PROVIDERS", "EmailError", "EmailMessage", "Mailer", "Sender", "get_mailer", "send_email", "send_in_background", "set_mailer_for_tests"]
