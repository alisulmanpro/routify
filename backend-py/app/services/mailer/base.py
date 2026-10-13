"""The provider-neutral email message and the interface every email provider implements."""
from __future__ import annotations

import re
from dataclasses import dataclass


class EmailError(RuntimeError):
    """A provider refused or failed to send. The message never includes credentials."""


_HEADER_UNSAFE = re.compile(r"[\r\n\x00]")


def _header(name: str, value: str | None) -> str | None:
    if value is not None and _HEADER_UNSAFE.search(value):
        raise EmailError(f"{name} must not contain line breaks")  # blocks header injection through names or subjects
    return value


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    text: str
    html: str | None = None
    to_name: str | None = None

    def __post_init__(self):
        _header("to", self.to)
        _header("to_name", self.to_name)
        _header("subject", self.subject)


@dataclass(frozen=True)
class Sender:
    email: str
    name: str
    reply_to: str | None = None

    def __post_init__(self):
        _header("from", self.email)
        _header("from name", self.name)
        _header("reply-to", self.reply_to)

    def formatted(self) -> str:
        from email.utils import formataddr

        return formataddr((self.name, self.email))


class Mailer:
    """Subclass this to add a provider: implement `send` and register it in `mailer.PROVIDERS`."""

    name = "base"

    def __init__(self, sender: Sender):
        self.sender = sender

    async def send(self, message: EmailMessage) -> None:
        raise NotImplementedError
