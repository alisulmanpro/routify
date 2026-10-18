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


def welcome(*, to: str, name: str, platform: str, support_email: str | None) -> EmailMessage:
    first = name.split()[0] if name.split() else name
    steps = [
        ("Add a route", "Tap Add route on Home, give it a name and pick the day. You can plan tomorrow's route tonight."),
        ("Add your stops", "Type, scan, speak or pin each address. Parcel IDs are optional."),
        ("Plan and go", "Choose Smartest, Nearest first or Most efficient, then follow the live navigation."),
    ]
    help_text = f"Questions? Reply to this email or write to {support_email}." if support_email else "Questions? Just reply to this email."
    text = (f"Hi {first},\n\nWelcome to {platform}! Your rider account is ready.\n\n"
            + "".join(f"{i}. {title}: {body}\n" for i, (title, body) in enumerate(steps, 1))
            + f"\n{help_text}\n\nSafe riding,\nThe {platform} team\n")
    rows = "".join(f"""
<tr><td style="padding:0 12px 14px 0;vertical-align:top"><span style="display:inline-block;width:24px;height:24px;line-height:24px;border-radius:12px;background:{ORANGE};color:#ffffff;font-weight:bold;font-size:13px;text-align:center">{i}</span></td>
<td style="padding:0 0 14px;font-size:14px"><strong>{escape(title)}</strong><br><span style="color:#475569">{escape(body)}</span></td></tr>"""
                   for i, (title, body) in enumerate(steps, 1))
    html = _layout(platform, f"Welcome, {first}!", f"""
<p style="margin:0 0 18px;font-size:14px">Your {escape(platform)} rider account is ready. Here is how to get going:</p>
<table role="presentation" cellspacing="0" cellpadding="0">{rows}</table>
<p style="margin:8px 0 0;font-size:12px;color:#64748b">{escape(help_text)}</p>""")
    return EmailMessage(to=to, to_name=_single_line(name), subject=f"Welcome to {_single_line(platform)}", text=text, html=html)


def _single_line(value: str) -> str:
    return " ".join(value.split())[:120]
