from __future__ import annotations

import io
import re
from typing import Any

from ..db import db
from ..errors import unprocessable
from ..uploads import UploadedFile, detect_file_type
from .subscription_service import assert_can_create_deliveries

I = re.IGNORECASE
TRACKING = re.compile(r"(?:tracking\s*(?:id|no\.?|number|#)?|awb(?:\s*(?:no\.?|number|#))?|consignment\s*(?:no\.?|number|#)?|cn\s*(?:no\.?|#)|order\s*(?:id|no\.?|number|#))\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{1,39})", I)
LABEL_ONLY = re.compile(r"^(tracking\s*(id|no\.?|number)?|awb(\s*(no\.?|number))?|consignment\s*(no\.?|number)?|customer(\s*name)?|consignee(\s*name)?|recipient|receiver|phone(\s*(no\.?|number))?|mobile(\s*(no\.?|number))?|contact(\s*(no\.?|number))?|address|delivery\s*address|payment\s*(type|mode|method)|cod(\s*amount)?|amount\s*to\s*collect|order\s*value)\s*[:\-]?$", I)
ANY_LABEL = re.compile(r"^[A-Za-z][A-Za-z .#/]{1,28}\s*:")
NAME = re.compile(r"(?:customer(?:\s*name)?|consignee(?:\s*name)?|recipient|receiver|deliver(?:y)?\s*to|name)\s*[:\-]\s*([^\n]+)", I)
PHONE = re.compile(r"(?:phone|mobile|contact|tel|cell)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*(\+?\d[\d\s\-()]{6,18}\d)", I)
PHONE_ANY = re.compile(r"(\+?\d[\d\s\-()]{8,16}\d)")
ADDRESS = re.compile(r"(?:delivery\s*address|address|addr)\s*[:\-]\s*([^\n]*)", I)
PAYMENT_TYPE = re.compile(r"payment\s*(?:type|mode|method)\s*[:\-]\s*([^\n]+)", I)
COD_AMOUNT = re.compile(r"(?:cod(?:\s*amount)?|cash\s*on\s*delivery|amount\s*to\s*collect|collectable(?:\s*amount)?|collection\s*amount)[^\d\n]{0,25}?(\d[\d,]*(?:\.\d{1,2})?)", I)
ORDER_VALUE = re.compile(r"(?:order\s*value|invoice\s*(?:value|amount)|declared\s*value|order\s*total)[^\d\n]{0,20}(\d[\d,]*(?:\.\d{1,2})?)", I)
COD_WORD = re.compile(r"\b(cod|cash\s*on\s*delivery)\b", I)
PREPAID_WORD = re.compile(r"\b(pre-?paid|paid\s*online|already\s*paid|payment\s*received)\b", I)


def _amount(s: str | None) -> float | None:
    return None if s is None else float(str(s).replace(",", ""))


def _group(pattern: re.Pattern, text: str) -> str | None:
    m = pattern.search(text)
    return m.group(1) if m else None


def _normalize(text: str) -> list[str]:
    """Joins "Label:" lines with the value on the following line, so both layouts parse the same way."""
    lines = [re.sub(r"\s+", " ", l).strip() for l in text.replace("\r", "").split("\n")]
    lines = [l for l in lines if l]
    out: list[str] = []
    i = 0
    while i < len(lines):
        if LABEL_ONLY.search(lines[i]) and i + 1 < len(lines):
            label = re.sub(r"[:\-]$", "", lines[i])
            out.append(f"{label}: {lines[i + 1]}")
            i += 2
        else:
            out.append(lines[i])
            i += 1
    return out


def _detect_payment(block: str) -> tuple[str | None, float | None]:
    explicit = (_group(PAYMENT_TYPE, block) or "").lower() or None
    cod_amount = _amount(_group(COD_AMOUNT, block))
    cod_word = bool(COD_WORD.search(block))
    prepaid_word = bool(PREPAID_WORD.search(block))

    kind = None
    if explicit:
        if re.search(r"\b(cod|cash)\b", explicit) and not re.search(r"prepaid|paid", explicit):
            kind = "cod"
        elif re.search(r"prepaid|pre-paid|paid|online|card", explicit) and not re.search(r"\b(cod|cash)\b", explicit):
            kind = "prepaid"
    elif cod_word and not prepaid_word and cod_amount != 0:
        kind = "cod"
    elif prepaid_word and not cod_word:
        kind = "prepaid"
    # Conflicting or missing signals stay None on purpose: the rider decides. Never guess.
    return kind, (cod_amount if kind == "cod" and cod_amount and cod_amount > 0 else None)


def _extract_table_rows(lines: list[str]) -> list[dict] | None:
    header = next((i for i, line in enumerate(lines) if re.search(r"\border\s*id\b", line, I) and re.search(r"\bcustomer\b", line, I)
                   and re.search(r"\bphone\b", line, I) and re.search(r"\bdelivery\s*address\b", line, I)), -1)
    if header < 0:
        return None

    items = []
    for line in lines[header + 1:]:
        row = re.match(r"^([A-Za-z0-9][A-Za-z0-9_-]{1,39})\s+(.+)$", line)
        if not row:
            continue
        rest = row.group(2)
        phone = next((m for m in re.finditer(r"\+?\d[\d\s()-]*\d", rest) if 9 <= len(re.sub(r"\D", "", m.group(0))) <= 15), None)
        if not phone:
            continue

        customer_name = rest[: phone.start()].strip()
        address = rest[phone.end():].strip()
        payment_type = cod_amount = order_value = None
        cod_suffix = re.search(r"\s+(?:COD|cash\s+on\s+delivery)(?:\s+[A-Z]{3})?\s+(\d[\d,]*(?:\.\d{1,2})?)\s*$", address, I)
        prepaid_suffix = re.search(r"\s+(?:prepaid|paid\s+online)(?:\s+[A-Z]{3})?\s+(\d[\d,]*(?:\.\d{1,2})?)\s*$", address, I)
        if cod_suffix:
            payment_type, cod_amount = "cod", _amount(cod_suffix.group(1))
            address = re.sub(r"[,;\s]+$", "", address[: cod_suffix.start()].strip())
        elif prepaid_suffix:
            payment_type, order_value = "prepaid", _amount(prepaid_suffix.group(1))
            address = re.sub(r"[,;\s]+$", "", address[: prepaid_suffix.start()].strip())

        flags = []
        if not customer_name:
            flags.append("missing_customer")
        if not address:
            flags.append("missing_address")
        if not payment_type:
            flags.append("payment_needs_review")
        if payment_type == "cod" and not (cod_amount and cod_amount > 0):
            flags.append("missing_cod_amount")
        items.append({"trackingId": row.group(1), "customerName": customer_name, "phone": phone.group(0).strip(), "address": address,
                      "paymentType": payment_type, "orderValue": order_value, "codAmount": cod_amount, "note": "", "flags": flags})
    return items


PAYMENT_FLAGS = {"payment_needs_review", "missing_cod_amount"}


def _without_payment(item: dict) -> dict:
    """Deliveries carry no payment details; payment columns are still parsed so they don't leak into addresses."""
    out = {k: v for k, v in item.items() if k not in ("paymentType", "orderValue", "codAmount")}
    out["flags"] = [f for f in item["flags"] if f not in PAYMENT_FLAGS]
    return out


def extract_deliveries_from_text(text: str) -> list[dict]:
    """Pure function (unit-tested): text of a courier manifest → reviewable drafts."""
    return [_without_payment(item) for item in _extract_with_payment(text)]


def _extract_with_payment(text: str) -> list[dict]:
    lines = _normalize(text)
    table = _extract_table_rows(lines)
    if table is not None:
        return table

    starts: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        found = _group(TRACKING, line)
        if found and (not starts or starts[-1][1] != found):
            starts.append((i, found))

    items = []
    for n, (i, tracking_id) in enumerate(starts):
        block_lines = lines[i: starts[n + 1][0] if n + 1 < len(starts) else len(lines)]
        block = "\n".join(block_lines)
        customer = (_group(NAME, block) or "").strip()
        phone = (_group(PHONE, block) or _group(PHONE_ANY, block.replace(tracking_id, "", 1)) or "").strip()

        address = ""
        addr_index = next((k for k, l in enumerate(block_lines) if ADDRESS.search(l)), -1)
        if addr_index >= 0:
            parts = [ADDRESS.search(block_lines[addr_index]).group(1)]
            k = addr_index + 1
            while k < len(block_lines) and not ANY_LABEL.search(block_lines[k]) and not TRACKING.search(block_lines[k]):
                parts.append(block_lines[k])
                k += 1
            address = re.sub(r"^,\s*", "", re.sub(r"\s+,", ",", ", ".join(parts))).strip()

        kind, cod_amount = _detect_payment(block)
        order_value = _amount(_group(ORDER_VALUE, block))
        flags = []
        if not address:
            flags.append("missing_address")
        if not customer:
            flags.append("missing_customer")
        if not phone:
            flags.append("missing_phone")
        if not kind:
            flags.append("payment_needs_review")
        if COD_WORD.search(block) and kind == "cod" and not cod_amount:
            flags.append("missing_cod_amount")
        items.append({"trackingId": tracking_id, "customerName": customer, "phone": phone, "address": address, "paymentType": kind,
                      "orderValue": order_value, "codAmount": cod_amount, "note": "", "flags": flags})
    return items


def extract_pdf_text(data: bytes) -> tuple[str, int]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        pages = len(reader.pages)
        if pages > 100:
            raise unprocessable("PDFs longer than 100 pages are not supported", "PDF_TOO_LARGE")
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as error:
        if getattr(error, "code", None) == "PDF_TOO_LARGE":
            raise
        raise unprocessable("This PDF could not be read. Check that the file is a valid, unprotected PDF.", "INVALID_PDF") from None
    return text, pages


ADDRESS_HEADER = re.compile(r"^(delivery\s*)?(address(es)?|stops?|locations?)\s*:?$", I)


def extract_addresses_from_lines(text: str) -> list[dict]:
    """Pure function: a plain list of stops, one address per line (a .txt file or a one-column sheet)."""
    items = []
    for raw in text.replace("\r", "").split("\n"):
        line = re.sub(r"^\d{1,3}[.)]\s+", "", re.sub(r"\s+", " ", raw).strip(" ,;\t"))  # drops "1. " numbering
        if len(line) < 5 or len(line) > 400 or ADDRESS_HEADER.match(line) or not re.search(r"[A-Za-z]", line):
            continue
        items.append({"trackingId": "", "customerName": "", "phone": "", "address": line, "note": "", "flags": []})
    return items[:300]


async def flag_duplicates(actor: dict, items: list[dict]) -> None:
    ids = [i["trackingId"] for i in items if i["trackingId"]]
    rows = await db.delivery.find_many(where={"riderId": actor["id"], "trackingId": {"in": ids}}) if ids else []
    existing = {r.trackingId for r in rows}
    seen: set[str] = set()
    for item in items:
        if not item["trackingId"]:
            continue
        if item["trackingId"] in existing or item["trackingId"] in seen:
            item["flags"].append("duplicate")
        seen.add(item["trackingId"])


async def build_draft(actor: dict, file: UploadedFile | None) -> dict[str, Any]:
    detect_file_type(file.data if file else None, ["pdf"])
    await assert_can_create_deliveries(actor, 1)

    import asyncio

    text, pages = await asyncio.to_thread(extract_pdf_text, file.data)
    if not text.strip():
        raise unprocessable("No text found. Scanned/image PDFs are not supported — add these deliveries manually.", "PDF_NO_TEXT")
    items = extract_deliveries_from_text(text) or extract_addresses_from_lines(text)
    if not items:
        raise unprocessable("No deliveries were recognised in this PDF. Add them manually instead.", "PDF_NO_DELIVERIES")
    await flag_duplicates(actor, items)
    return {"pages": pages, "items": items}
