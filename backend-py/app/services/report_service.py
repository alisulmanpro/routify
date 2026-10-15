from __future__ import annotations

import asyncio
import io
from typing import Any
from xml.sax.saxutils import escape

from ..db import as_json, db, lock_rider, transaction
from ..errors import forbidden, not_found, unprocessable
from ..http import iso, now
from ..ids import new_id
from ..security import sign_file_url
from . import storage_service as storage
from .route_service import summarize
from .settings_service import get_settings
from .subscription_service import assert_can_create_report


def serialize_report(r: Any, **extra) -> dict:
    return {
        "id": r.id, "date": r.date, "riderId": r.riderId,
        "summary": r.summary, "generatedAt": r.generatedAt, "fileSize": r.fileSize,
        "downloadUrl": sign_file_url(r.fileKey, download=True), "viewUrl": sign_file_url(r.fileKey), **extra,
    }


LABEL = {"customer_unavailable": "Customer unavailable", "customer_refused": "Customer refused", "wrong_address": "Wrong address",
         "phone_unreachable": "Phone unreachable", "business_closed": "Business closed", "payment_issue": "Payment issue", "other": "Other"}


def _render_pdf(*, rider_name: str, date: str, summary: dict, deliveries: list[Any], photos: dict[str, bytes | None]) -> bytes:
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import HRFlowable, Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=40, rightMargin=40, topMargin=40, bottomMargin=40,
                            title=f"Delivery report {date}", author="Routify")
    title = ParagraphStyle("title", fontName="Helvetica", fontSize=20, leading=24)
    muted = ParagraphStyle("muted", fontName="Helvetica", fontSize=11, leading=14, textColor=HexColor("#555555"))
    heading = ParagraphStyle("heading", fontName="Helvetica", fontSize=13, leading=16, spaceAfter=4)
    body = ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=13)
    bold = ParagraphStyle("bold", fontName="Helvetica-Bold", fontSize=11, leading=14)
    error = ParagraphStyle("error", parent=body, textColor=HexColor("#bb0000"))
    t = lambda s: escape(str(s))  # noqa: E731

    story: list = [Paragraph("Daily delivery report", title), Spacer(0, 3),
                   Paragraph(f"Rider: {t(rider_name)}&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;Date: {t(date)}", muted), Spacer(0, 12),
                   Paragraph("Route summary", heading)]
    for key, value in [("Total deliveries", summary["total"]), ("Delivered", summary["delivered"]), ("Failed", summary["failed"]),
                       ("Not completed", summary["pending"]), ("Distance (planned)", f"{summary['distanceKm']} km"),
                       ("Route time", f"{summary['routeMinutes']} min" if summary["routeMinutes"] else "-")]:
        story.append(Paragraph(f"{t(key)}: <b>{t(value)}</b>", body))
    story.append(Spacer(0, 12))

    for index, d in enumerate(deliveries):
        status = str(d.status)
        block: list = [HRFlowable(width="100%", thickness=0.5, color=HexColor("#dddddd"), spaceAfter=6),
                       Paragraph(t(f"{index + 1}. Parcel {d.trackingId} - {status.upper().replace('_', ' ', 1)}"), bold)]
        customer = "  ".join(x for x in [d.customerName, f"({d.customerPhone})" if d.customerPhone else ""] if x)
        if customer:
            block.append(Paragraph(t(f"Customer: {customer}"), body))
        block.append(Paragraph(t(f"Address: {d.addressRaw}"), body))
        when = d.deliveredAt or d.failedAt
        if when:
            block.append(Paragraph(t(f"{'Delivered' if status == 'delivered' else 'Failed'} at: {iso(when).replace('T', ' ')[:19]} UTC"), body))
        if d.failureReason:
            reason = LABEL.get(str(d.failureReason), str(d.failureReason))
            block.append(Paragraph(t(f"Failure reason: {reason}{f' - {d.failureNote}' if d.failureNote else ''}"), body))
        if d.note:
            block.append(Paragraph(t(f"Note: {d.note}"), body))
        if d.id in photos:
            data = photos[d.id]
            try:
                if not data:
                    raise ValueError
                w, h = ImageReader(io.BytesIO(data)).getSize()
                scale = min(220 / w, 160 / h, 1e9)
                image = Image(io.BytesIO(data), width=w * scale, height=h * scale)
                image.hAlign = "LEFT"
                block += [Spacer(0, 4), image, Spacer(0, 4)]
            except Exception:  # noqa: BLE001
                block.append(Paragraph("Proof photo could not be loaded.", error))
        block.append(Spacer(0, 8))
        story.append(KeepTogether(block))

    doc.build(story)
    return buffer.getvalue()


def _by_route_order(d: Any):
    # Unrouted deliveries first (MongoDB sorts nulls first), then stop order, then creation time.
    return (d.stopOrder is not None, d.stopOrder or 0, d.createdAt, d.id)


async def generate(actor: dict, date: str) -> dict:
    if actor["role"] != "rider":
        raise forbidden("Only riders generate reports")
    deliveries = sorted(await db.delivery.find_many(where={"riderId": actor["id"], "serviceDate": date}), key=_by_route_order)
    if not deliveries:
        raise unprocessable("There are no deliveries for this date", "NO_DELIVERIES")

    existing = await db.report.find_unique(where={"riderId_date": {"riderId": actor["id"], "date": date}})
    await assert_can_create_report(actor, not existing)  # early refusal before the slow render; re-checked under the lock below

    rider, route, settings = await asyncio.gather(
        db.user.find_unique(where={"id": actor["id"]}),
        db.route.find_first(where={"riderId": actor["id"], "serviceDate": date, "status": {"in": ["completed", "active"]}},
                            order=[{"createdAt": "desc"}, {"id": "desc"}]),
        get_settings(),
    )
    summary = summarize(deliveries, route)

    photos: dict[str, bytes | None] = {}
    if settings["reports"]["includePhotos"]:
        for d in deliveries:
            if d.proofPhotoKey:
                try:
                    photos[d.id] = await storage.read(d.proofPhotoKey)
                except Exception:  # noqa: BLE001
                    photos[d.id] = None
    pdf = await asyncio.to_thread(_render_pdf, rider_name=rider.fullName, date=date, summary=summary, deliveries=deliveries, photos=photos)
    file_key = await storage.save(pdf, "reports", "pdf")

    data = {"summary": as_json(summary), "fileKey": file_key, "fileSize": len(pdf), "generatedAt": now()}
    try:
        # Rendering runs unlocked (it can take seconds); the limit check and the save are serialised per rider,
        # so parallel requests cannot both slip under the monthly report limit.
        async with transaction() as tx:
            await lock_rider(tx, actor["id"])
            existing = await tx.report.find_unique(where={"riderId_date": {"riderId": actor["id"], "date": date}})
            await assert_can_create_report(actor, not existing, tx)
            report = await tx.report.upsert(
                where={"riderId_date": {"riderId": actor["id"], "date": date}},
                data={"create": {"id": new_id(), "riderId": actor["id"], "date": date, **data}, "update": data},
            )
    except Exception:
        await storage.remove(file_key)
        raise
    if existing and existing.fileKey:
        await storage.remove(existing.fileKey)
    return serialize_report(report)


async def find_visible(actor: dict, report_id: str) -> Any:
    where = {"id": report_id, "riderId": actor["id"]} if actor["role"] == "rider" else {"id": report_id}
    report = await db.report.find_first(where=where)
    if not report:
        raise not_found("Report")
    return report


async def list_mine(actor: dict, limit: int = 60) -> list[dict]:
    reports = await db.report.find_many(where={"riderId": actor["id"]}, order=[{"date": "desc"}, {"id": "desc"}], take=limit)
    return [serialize_report(r) for r in reports]
