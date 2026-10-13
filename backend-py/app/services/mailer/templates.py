"""Transactional email bodies. Every value from a user is HTML-escaped before it reaches the HTML part."""
from __future__ import annotations

from html import escape

from .base import EmailMessage

ORANGE = "#f97316"
NAVY = "#0f172a"


def _layout(platform: str, heading: str, body_html: str) -> str:
    return f"""<!doctype html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:{NAVY}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px">
<tr><td style="padding:20px 24px;background:{NAVY};border-radius:12px 12px 0 0;color:#ffffff;font-size:18px;font-weight:bold">{escape(platform)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">{escape(heading)}</h1>
{body_html}
</td></tr></table></body></html>"""


def password_reset_code(*, to: str, name: str, code: str, minutes: int, platform: str) -> EmailMessage:
    text = (f"Hi {name},\n\nUse this code to reset your {platform} password:\n\n    {code}\n\n"
            f"It expires in {minutes} minutes and can be used once.\n\n"
            "If you did not ask to reset your password, you can ignore this email: your password stays the same.\n")
    html = _layout(platform, "Reset your password", f"""
<p style="margin:0 0 16px;font-size:14px">Hi {escape(name)}, use this code to reset your password:</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:bold;letter-spacing:8px;color:{ORANGE}">{escape(code)}</p>
<p style="margin:0 0 16px;font-size:14px">It expires in {minutes} minutes and can be used once.</p>
<p style="margin:0;font-size:12px;color:#64748b">If you did not ask to reset your password, ignore this email: your password stays the same.</p>""")
    return EmailMessage(to=to, to_name=_single_line(name), subject=f"Your {_single_line(platform)} password reset code", text=text, html=html)


def password_changed(*, to: str, name: str, platform: str, support_email: str | None) -> EmailMessage:
    contact = f" contact {support_email}" if support_email else " reset your password right away"
    text = (f"Hi {name},\n\nThe password for your {platform} account was just changed, and every other device was signed out.\n\n"
            f"If this was not you,{contact}.\n")
    html = _layout(platform, "Your password was changed", f"""
<p style="margin:0 0 16px;font-size:14px">Hi {escape(name)}, the password for your account was just changed, and every other device was signed out.</p>
<p style="margin:0;font-size:12px;color:#64748b">If this was not you,{escape(contact)}.</p>""")
    return EmailMessage(to=to, to_name=_single_line(name), subject=f"Your {_single_line(platform)} password was changed", text=text, html=html)


def _single_line(value: str) -> str:
    return " ".join(value.split())[:120]
