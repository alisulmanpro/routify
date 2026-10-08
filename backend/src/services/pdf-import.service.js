import { PDFParse } from 'pdf-parse';
import { Delivery } from '../models/delivery.js';
import { detectFileType } from '../middleware/upload.js';
import { unprocessable } from '../utils/errors.js';
import { assertCanCreateDeliveries } from './subscription.service.js';

const TRACKING = /(?:tracking\s*(?:id|no\.?|number|#)?|awb(?:\s*(?:no\.?|number|#))?|consignment\s*(?:no\.?|number|#)?|cn\s*(?:no\.?|#)|order\s*(?:id|no\.?|number|#))\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{1,39})/i;
const LABEL_ONLY = /^(tracking\s*(id|no\.?|number)?|awb(\s*(no\.?|number))?|consignment\s*(no\.?|number)?|customer(\s*name)?|consignee(\s*name)?|recipient|receiver|phone(\s*(no\.?|number))?|mobile(\s*(no\.?|number))?|contact(\s*(no\.?|number))?|address|delivery\s*address|payment\s*(type|mode|method)|cod(\s*amount)?|amount\s*to\s*collect|order\s*value)\s*[:\-]?$/i;
const ANY_LABEL = /^[A-Za-z][A-Za-z .#/]{1,28}\s*:/;
const NAME = /(?:customer(?:\s*name)?|consignee(?:\s*name)?|recipient|receiver|deliver(?:y)?\s*to|name)\s*[:\-]\s*([^\n]+)/i;
const PHONE = /(?:phone|mobile|contact|tel|cell)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*(\+?\d[\d\s\-()]{6,18}\d)/i;
const PHONE_ANY = /(\+?\d[\d\s\-()]{8,16}\d)/;
const ADDRESS = /(?:delivery\s*address|address|addr)\s*[:\-]\s*([^\n]*)/i;
const PAYMENT_TYPE = /payment\s*(?:type|mode|method)\s*[:\-]\s*([^\n]+)/i;
const COD_AMOUNT = /(?:cod(?:\s*amount)?|cash\s*on\s*delivery|amount\s*to\s*collect|collectable(?:\s*amount)?|collection\s*amount)[^\d\n]{0,25}?(\d[\d,]*(?:\.\d{1,2})?)/i;
const ORDER_VALUE = /(?:order\s*value|invoice\s*(?:value|amount)|declared\s*value|order\s*total)[^\d\n]{0,20}(\d[\d,]*(?:\.\d{1,2})?)/i;
const COD_WORD = /\b(cod|cash\s*on\s*delivery)\b/i;
const PREPAID_WORD = /\b(pre-?paid|paid\s*online|already\s*paid|payment\s*received)\b/i;

const amount = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

/** Joins "Label:" lines with the value on the following line, so both layouts parse the same way. */
function normalize(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (LABEL_ONLY.test(lines[i]) && lines[i + 1]) { out.push(`${lines[i].replace(/[:\-]$/, '')}: ${lines[i + 1]}`); i += 1; } else out.push(lines[i]);
  }
  return out;
}

function detectPayment(block) {
  const explicit = block.match(PAYMENT_TYPE)?.[1]?.toLowerCase();
  const codAmount = amount(block.match(COD_AMOUNT)?.[1]);
  const codWord = COD_WORD.test(block);
  const prepaidWord = PREPAID_WORD.test(block);

  let type = null;
  if (explicit) {
    if (/\b(cod|cash)\b/.test(explicit) && !/prepaid|paid/.test(explicit)) type = 'cod';
    else if (/prepaid|pre-paid|paid|online|card/.test(explicit) && !/\b(cod|cash)\b/.test(explicit)) type = 'prepaid';
  } else if (codWord && !prepaidWord && codAmount !== 0) type = 'cod';
  else if (prepaidWord && !codWord) type = 'prepaid';
  // Conflicting or missing signals stay null on purpose: the rider decides. Never guess.
  return { type, codAmount: type === 'cod' && codAmount > 0 ? codAmount : null };
}

function extractTableRows(lines) {
  const headerIndex = lines.findIndex((line) => /\border\s*id\b/i.test(line) && /\bcustomer\b/i.test(line) && /\bphone\b/i.test(line) && /\bdelivery\s*address\b/i.test(line));
  if (headerIndex < 0) return null;

  return lines.slice(headerIndex + 1).flatMap((line) => {
    const row = /^([A-Za-z0-9][A-Za-z0-9_-]{1,39})\s+(.+)$/.exec(line);
    if (!row) return [];

    const phoneMatches = [...row[2].matchAll(/\+?\d[\d\s()-]*\d/g)];
    const phoneMatch = phoneMatches.find((match) => {
      const digits = match[0].replace(/\D/g, '').length;
      return digits >= 9 && digits <= 15;
    });
    if (!phoneMatch) return [];

    const customerName = row[2].slice(0, phoneMatch.index).trim();
    let address = row[2].slice(phoneMatch.index + phoneMatch[0].length).trim();
    let paymentType = null;
    let codAmount = null;
    let orderValue = null;

    const codSuffix = /\s+(?:COD|cash\s+on\s+delivery)(?:\s+[A-Z]{3})?\s+(\d[\d,]*(?:\.\d{1,2})?)\s*$/i.exec(address);
    const prepaidSuffix = /\s+(?:prepaid|paid\s+online)(?:\s+[A-Z]{3})?\s+(\d[\d,]*(?:\.\d{1,2})?)\s*$/i.exec(address);
    if (codSuffix) {
      paymentType = 'cod';
      codAmount = amount(codSuffix[1]);
      address = address.slice(0, codSuffix.index).trim().replace(/[,;\s]+$/, '');
    } else if (prepaidSuffix) {
      paymentType = 'prepaid';
      orderValue = amount(prepaidSuffix[1]);
      address = address.slice(0, prepaidSuffix.index).trim().replace(/[,;\s]+$/, '');
    }

    const flags = [];
    if (!customerName) flags.push('missing_customer');
    if (!address) flags.push('missing_address');
    if (!paymentType) flags.push('payment_needs_review');
    if (paymentType === 'cod' && !(codAmount > 0)) flags.push('missing_cod_amount');

    return [{
      trackingId: row[1], customerName, phone: phoneMatch[0].trim(), address,
      paymentType, orderValue, codAmount, note: '', flags,
    }];
  });
}

const PAYMENT_FLAGS = new Set(['payment_needs_review', 'missing_cod_amount']);
/** Deliveries carry no payment details; payment columns are still parsed so they don't leak into addresses. */
const withoutPayment = ({ paymentType, orderValue, codAmount, ...item }) => ({ ...item, flags: item.flags.filter((flag) => !PAYMENT_FLAGS.has(flag)) });

/** Pure function (unit-tested): text of a courier manifest → reviewable drafts. */
export function extractDeliveriesFromText(text) {
  return extractWithPayment(text).map(withoutPayment);
}

function extractWithPayment(text) {
  const lines = normalize(text);
  const tableItems = extractTableRows(lines);
  if (tableItems) return tableItems;

  const starts = [];
  lines.forEach((line, i) => {
    const id = line.match(TRACKING)?.[1];
    if (id && (!starts.length || starts[starts.length - 1].id !== id)) starts.push({ i, id });
  });

  return starts.map(({ i, id }, n) => {
    const blockLines = lines.slice(i, n + 1 < starts.length ? starts[n + 1].i : lines.length);
    const block = blockLines.join('\n');
    const customer = block.match(NAME)?.[1]?.trim() || '';
    const phone = (block.match(PHONE)?.[1] || block.replace(id, '').match(PHONE_ANY)?.[1] || '').trim();

    let address = '';
    const addrIndex = blockLines.findIndex((l) => ADDRESS.test(l));
    if (addrIndex >= 0) {
      const parts = [blockLines[addrIndex].match(ADDRESS)[1]];
      for (let k = addrIndex + 1; k < blockLines.length && !ANY_LABEL.test(blockLines[k]) && !TRACKING.test(blockLines[k]); k += 1) parts.push(blockLines[k]);
      address = parts.join(', ').replace(/\s+,/g, ',').replace(/^,\s*/, '').trim();
    }

    const { type, codAmount } = detectPayment(block);
    const orderValue = amount(block.match(ORDER_VALUE)?.[1]);
    const flags = [];
    if (!address) flags.push('missing_address');
    if (!customer) flags.push('missing_customer');
    if (!phone) flags.push('missing_phone');
    if (!type) flags.push('payment_needs_review');
    if (COD_WORD.test(block) && type === 'cod' && !codAmount) flags.push('missing_cod_amount');

    return { trackingId: id, customerName: customer, phone, address, paymentType: type, orderValue: orderValue ?? null, codAmount, note: '', flags };
  });
}

export async function buildDraft(actor, file) {
  detectFileType(file?.buffer, ['pdf']);
  await assertCanCreateDeliveries(actor, 1);

  let text;
  let pages;
  const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
  try {
    const result = await parser.getText();
    text = result.text || '';
    pages = result.total;
  } catch {
    throw unprocessable('This PDF could not be read. Check that the file is a valid, unprotected PDF.', 'INVALID_PDF');
  } finally {
    await parser.destroy().catch(() => {});
  }
  if (pages > 100) throw unprocessable('PDFs longer than 100 pages are not supported', 'PDF_TOO_LARGE');
  if (!text.trim()) throw unprocessable('No text found. Scanned/image PDFs are not supported — add these deliveries manually.', 'PDF_NO_TEXT');

  const items = extractDeliveriesFromText(text);
  if (!items.length) throw unprocessable('No deliveries were recognised in this PDF. Add them manually instead.', 'PDF_NO_DELIVERIES');

  const existing = new Set((await Delivery.find({ riderId: actor.id, trackingId: { $in: items.map((i) => i.trackingId) } }).select('trackingId').lean()).map((d) => d.trackingId));
  const seen = new Set();
  for (const item of items) {
    if (existing.has(item.trackingId) || seen.has(item.trackingId)) item.flags.push('duplicate');
    seen.add(item.trackingId);
  }
  return { pages, items };
}
