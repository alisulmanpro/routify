"""Forgot-password flow and the provider-neutral mailer."""
from __future__ import annotations

import re

import httpx
import pytest

from app import background
from app.db import db
from app.services import mailer
from app.services.mailer import EmailError, EmailMessage, Mailer, Sender
from app.services.mailer.providers import BrevoMailer, MailgunMailer, PostmarkMailer, ResendMailer, SendGridMailer

from .test_api import PASSWORD, rider

NEW_PASSWORD = "a-brand-new-pass1"


class Outbox(Mailer):
    name = "outbox"

    def __init__(self):
        super().__init__(Sender("no-reply@example.com", "Routify"))
        self.sent: list[EmailMessage] = []

    async def send(self, message: EmailMessage) -> None:
        self.sent.append(message)

    def code_for(self, email: str) -> str:
        message = next(m for m in reversed(self.sent) if m.to == email and "reset code" in m.subject)
        return re.search(r"\b(\d{6})\b", message.text).group(1)


@pytest.fixture
def outbox():
    box = Outbox()
    mailer.set_mailer_for_tests(box)
    yield box
    mailer.set_mailer_for_tests(None)


async def forgot(client, email):
    res = await client.post("/api/v1/auth/forgot-password", json={"email": email})
    await background.wait_all()
    return res


async def reset(client, email, code, password=NEW_PASSWORD):
    return await client.post("/api/v1/auth/reset-password", json={"email": email, "code": code, "newPassword": password, "confirmPassword": password})


async def test_full_reset_flow_signs_out_everywhere_and_unlocks(client, outbox):
    body, auth = await rider(client, "reset-me@example.com")
    await db.user.update(where={"id": body["user"]["id"]}, data={"failedLoginCount": 5, "lockedUntil": None})

    res = await forgot(client, "Reset-Me@example.com")
    assert res.status_code == 200 and res.json()["data"]["sent"] is True
    code = outbox.code_for("reset-me@example.com")
    assert "<" not in outbox.sent[-1].subject

    verify = await client.post("/api/v1/auth/reset-password/verify", json={"email": "reset-me@example.com", "code": code})
    assert verify.status_code == 200 and verify.json()["data"]["valid"] is True

    done = await reset(client, "reset-me@example.com", code)
    assert done.status_code == 200 and done.json()["data"] == {"reset": True}
    await background.wait_all()
    assert any("password was changed" in m.subject for m in outbox.sent)

    # Old access + refresh tokens are dead; the old password no longer works; the new one does.
    assert (await client.get("/api/v1/auth/me", headers=auth)).status_code == 401
    assert (await client.post("/api/v1/auth/refresh", json={"refreshToken": body["refreshToken"]})).status_code == 401
    assert (await client.post("/api/v1/auth/login", json={"email": "reset-me@example.com", "password": PASSWORD})).status_code == 401
    assert (await client.post("/api/v1/auth/login", json={"email": "reset-me@example.com", "password": NEW_PASSWORD})).status_code == 200

    # A code works once.
    assert (await reset(client, "reset-me@example.com", code, "another-new-pass2")).json()["error"]["code"] == "INVALID_RESET_CODE"


async def test_unknown_email_gets_the_same_answer_and_no_email(client, outbox):
    await rider(client, "known-reset@example.com")
    known = await forgot(client, "known-reset@example.com")
    unknown = await forgot(client, "nobody-here@example.com")
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert [m.to for m in outbox.sent] == ["known-reset@example.com"]
    assert (await reset(client, "nobody-here@example.com", "123456")).json()["error"]["code"] == "INVALID_RESET_CODE"


async def test_wrong_guesses_burn_the_code(client, outbox):
    await rider(client, "guess@example.com")
    await forgot(client, "guess@example.com")
    code = outbox.code_for("guess@example.com")
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"
    for _ in range(5):
        res = await client.post("/api/v1/auth/reset-password/verify", json={"email": "guess@example.com", "code": wrong})
        assert res.status_code == 400
    # Even the right code is refused once the budget is spent.
    assert (await reset(client, "guess@example.com", code)).json()["error"]["code"] == "INVALID_RESET_CODE"


async def test_new_request_replaces_old_code_and_weak_password_keeps_code(client, outbox):
    await rider(client, "twice@example.com")
    await forgot(client, "twice@example.com")
    first = outbox.code_for("twice@example.com")
    await forgot(client, "twice@example.com")
    second = outbox.code_for("twice@example.com")
    if first != second:
        assert (await reset(client, "twice@example.com", first)).status_code == 400
    weak = await reset(client, "twice@example.com", second, "short")
    assert weak.status_code == 400 and weak.json()["error"]["code"] == "VALIDATION_ERROR"
    assert (await reset(client, "twice@example.com", second)).status_code == 200


async def test_suspended_accounts_get_no_code(client, outbox):
    body, _ = await rider(client, "suspended-reset@example.com")
    await db.user.update(where={"id": body["user"]["id"]}, data={"status": "suspended"})
    await forgot(client, "suspended-reset@example.com")
    assert not outbox.sent


async def test_codes_are_stored_hashed(client, outbox):
    body, _ = await rider(client, "hashed@example.com")
    await forgot(client, "hashed@example.com")
    code = outbox.code_for("hashed@example.com")
    row = await db.passwordreset.find_first(where={"userId": body["user"]["id"]})
    assert row and code not in row.codeHash and len(row.codeHash) == 64


async def test_reset_requests_are_capped_per_email(client, outbox):
    from app.middleware import reset_email_limiter

    reset_email_limiter.enforce = True
    try:
        for _ in range(reset_email_limiter.limit):
            assert (await forgot(client, "flood@example.com")).status_code == 200
        assert (await forgot(client, "flood@example.com")).status_code == 429
    finally:
        reset_email_limiter.enforce = None
        await db.ratelimit.delete_many(where={"key": {"startswith": "reset-email:"}})


async def test_reset_code_must_be_six_ascii_digits(client):
    for code in ("12345", "1234567", "abcdef", "١٢٣٤٥٦"):
        res = await client.post("/api/v1/auth/reset-password/verify", json={"email": "x@example.com", "code": code})
        assert res.status_code == 400 and res.json()["error"]["code"] == "VALIDATION_ERROR", code


# ---------------------------------------------------------------- mailer

def test_header_injection_is_rejected():
    with pytest.raises(EmailError):
        EmailMessage(to="a@example.com", subject="Hi\r\nBcc: victim@example.com", text="x")
    with pytest.raises(EmailError):
        Sender("a@example.com", "Evil\nName")


def test_templates_escape_user_names():
    from app.services.mailer import templates

    msg = templates.password_reset_code(to="a@example.com", name="<script>x</script>", code="123456", minutes=15, platform="Routify\nInc")
    assert "<script>" not in msg.html and "&lt;script&gt;" in msg.html
    assert "\n" not in msg.subject


@pytest.mark.parametrize("cls,host", [(BrevoMailer, "api.brevo.com"), (SendGridMailer, "api.sendgrid.com"), (ResendMailer, "api.resend.com"),
                                      (MailgunMailer, "api.mailgun.net"), (PostmarkMailer, "api.postmarkapp.com")])
async def test_http_providers_build_requests_and_raise_on_rejection(cls, host, monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(401 if len(seen) > 1 else 200, text="bad key")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=transport, **kw))
    provider = cls(Sender("from@example.com", "Routify", reply_to="help@example.com"), api_key="test-key")
    message = EmailMessage(to="rider@example.com", subject="Hello", text="Plain", html="<b>Html</b>")

    await provider.send(message)
    assert seen[0].url.host == host and b"rider" in seen[0].content
    assert any("test-key" in value for value in seen[0].headers.values()) or seen[0].headers["authorization"].startswith("Basic ")
    with pytest.raises(EmailError):
        await provider.send(message)


def test_every_configurable_provider_is_registered():
    from app.config import EMAIL_PROVIDERS

    assert set(EMAIL_PROVIDERS) == set(mailer.PROVIDERS)


async def test_in_app_password_change_sends_a_notice(client, outbox):
    _, auth = await rider(client, "change-notice@example.com", name="Ali Rider")
    res = await client.post("/api/v1/auth/change-password", headers=auth, json={"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})
    assert res.status_code == 200
    await background.wait_all()
    notices = [m for m in outbox.sent if m.to == "change-notice@example.com"]
    assert len(notices) == 1
    assert notices[0].subject == "Your Routify password was changed"
    assert "Ali Rider" in notices[0].text and "signed out" in notices[0].text

    # A wrong current password changes nothing and sends nothing.
    outbox.sent.clear()
    bad = await client.post("/api/v1/auth/change-password", headers=bearer(res.json()["data"]["accessToken"]),
                            json={"currentPassword": "wrong-password", "newPassword": "another-pass-123"})
    assert bad.status_code == 422
    await background.wait_all()
    assert not outbox.sent


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_same_password_in_both_boxes_gets_a_clear_message(client):
    _, auth = await rider(client, "same-twice@example.com")
    res = await client.post("/api/v1/auth/change-password", headers=auth, json={"currentPassword": NEW_PASSWORD, "newPassword": NEW_PASSWORD})
    assert res.status_code == 422 and res.json()["error"]["code"] == "SAME_PASSWORD"


async def test_new_riders_get_a_welcome_email(client, outbox):
    await rider(client, "welcome-me@example.com", name="Ali <b>Raza</b>")
    await background.wait_all()
    welcome = [m for m in outbox.sent if m.to == "welcome-me@example.com"]
    assert len(welcome) == 1 and welcome[0].subject.startswith("Welcome to")
    assert "Hi Ali" in welcome[0].text and "Add a route" in welcome[0].text
    assert "<b>Raza" not in welcome[0].html, "the name must be escaped in the HTML part"
