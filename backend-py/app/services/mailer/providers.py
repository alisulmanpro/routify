"""Built-in email providers. Each one is a thin adapter over the provider's own API (or plain SMTP)."""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage as MimeMessage
from email.utils import formataddr, make_msgid

import httpx

from ...config import env
from ...logger import log
from .base import EmailError, EmailMessage, Mailer, Sender

TIMEOUT = 15.0


class ConsoleMailer(Mailer):
    """Development only: writes the email to the log instead of sending it."""

    name = "console"

    async def send(self, message: EmailMessage) -> None:
        log(logging.INFO, "Email (console provider, not sent)", to=message.to, subject=message.subject, text=message.text)


class DisabledMailer(Mailer):
    name = "disabled"

    async def send(self, message: EmailMessage) -> None:
        log(logging.WARNING, "Email not sent: EMAIL_PROVIDER is disabled", subject=message.subject)


class SmtpMailer(Mailer):
    """Works with any SMTP relay: Brevo, SendGrid, Mailgun, SES, Postmark, Gmail/Workspace, Zoho, your own server..."""

    name = "smtp"

    def _mime(self, message: EmailMessage) -> MimeMessage:
        mime = MimeMessage()
        mime["From"] = self.sender.formatted()
        mime["To"] = formataddr((message.to_name or "", message.to))
        mime["Subject"] = message.subject
        mime["Message-ID"] = make_msgid(domain=self.sender.email.rsplit("@", 1)[-1])
        if self.sender.reply_to:
            mime["Reply-To"] = self.sender.reply_to
        mime.set_content(message.text)
        if message.html:
            mime.add_alternative(message.html, subtype="html")
        return mime

    def _send_sync(self, mime: MimeMessage) -> None:
        context = ssl.create_default_context()
        if env.SMTP_SECURITY == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(env.SMTP_HOST, env.SMTP_PORT, timeout=TIMEOUT, context=context)
        else:
            server = smtplib.SMTP(env.SMTP_HOST, env.SMTP_PORT, timeout=TIMEOUT)
        try:
            server.ehlo()
            if env.SMTP_SECURITY == "starttls":
                server.starttls(context=context)
                server.ehlo()
            if env.SMTP_USERNAME:
                server.login(env.SMTP_USERNAME, env.SMTP_PASSWORD or "")
            server.send_message(mime)
        finally:
            try:
                server.quit()
            except smtplib.SMTPException:
                server.close()

    async def send(self, message: EmailMessage) -> None:
        try:
            await asyncio.to_thread(self._send_sync, self._mime(message))
        except (smtplib.SMTPException, OSError) as error:
            raise EmailError(f"SMTP send failed: {type(error).__name__}") from error


class HttpMailer(Mailer):
    """Base for providers with a JSON/HTTP API: subclasses only build the request."""

    def __init__(self, sender: Sender, api_key: str | None = None):
        super().__init__(sender)
        self.api_key = api_key or env.EMAIL_API_KEY or ""

    def request(self, message: EmailMessage) -> dict:
        raise NotImplementedError

    async def send(self, message: EmailMessage) -> None:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                response = await client.post(**self.request(message))
        except httpx.HTTPError as error:
            raise EmailError(f"{self.name} request failed: {type(error).__name__}") from error
        if response.status_code >= 300:
            # Provider error bodies describe the problem (bad sender, quota...) and never echo the API key.
            raise EmailError(f"{self.name} rejected the email ({response.status_code}): {response.text[:300]}")


class BrevoMailer(HttpMailer):
    name = "brevo"

    def request(self, message: EmailMessage) -> dict:
        body = {"sender": {"email": self.sender.email, "name": self.sender.name}, "to": [{"email": message.to, **({"name": message.to_name} if message.to_name else {})}],
                "subject": message.subject, "textContent": message.text}
        if message.html:
            body["htmlContent"] = message.html
        if self.sender.reply_to:
            body["replyTo"] = {"email": self.sender.reply_to}
        return {"url": "https://api.brevo.com/v3/smtp/email", "json": body, "headers": {"api-key": self.api_key, "accept": "application/json"}}


class SendGridMailer(HttpMailer):
    name = "sendgrid"

    def request(self, message: EmailMessage) -> dict:
        content = [{"type": "text/plain", "value": message.text}] + ([{"type": "text/html", "value": message.html}] if message.html else [])
        body = {"personalizations": [{"to": [{"email": message.to}]}], "from": {"email": self.sender.email, "name": self.sender.name},
                "subject": message.subject, "content": content}
        if self.sender.reply_to:
            body["reply_to"] = {"email": self.sender.reply_to}
        host = "api.eu.sendgrid.com" if env.EMAIL_API_REGION == "eu" else "api.sendgrid.com"
        return {"url": f"https://{host}/v3/mail/send", "json": body, "headers": {"Authorization": f"Bearer {self.api_key}"}}


class ResendMailer(HttpMailer):
    name = "resend"

    def request(self, message: EmailMessage) -> dict:
        body = {"from": self.sender.formatted(), "to": [message.to], "subject": message.subject, "text": message.text}
        if message.html:
            body["html"] = message.html
        if self.sender.reply_to:
            body["reply_to"] = self.sender.reply_to
        return {"url": "https://api.resend.com/emails", "json": body, "headers": {"Authorization": f"Bearer {self.api_key}"}}


class MailgunMailer(HttpMailer):
    name = "mailgun"

    def request(self, message: EmailMessage) -> dict:
        data = {"from": self.sender.formatted(), "to": formataddr((message.to_name or "", message.to)), "subject": message.subject, "text": message.text}
        if message.html:
            data["html"] = message.html
        if self.sender.reply_to:
            data["h:Reply-To"] = self.sender.reply_to
        host = "api.eu.mailgun.net" if env.EMAIL_API_REGION == "eu" else "api.mailgun.net"
        return {"url": f"https://{host}/v3/{env.MAILGUN_DOMAIN}/messages", "data": data, "auth": ("api", self.api_key)}


class PostmarkMailer(HttpMailer):
    name = "postmark"

    def request(self, message: EmailMessage) -> dict:
        body = {"From": self.sender.formatted(), "To": message.to, "Subject": message.subject, "TextBody": message.text, "MessageStream": "outbound"}
        if message.html:
            body["HtmlBody"] = message.html
        if self.sender.reply_to:
            body["ReplyTo"] = self.sender.reply_to
        return {"url": "https://api.postmarkapp.com/email", "json": body,
                "headers": {"X-Postmark-Server-Token": self.api_key, "Accept": "application/json"}}

