// Helpers for reading parcel labels: the OCR lines from a photo, or the text of a barcode/QR code.
import { findEircode, findUkPostcode, formatIrishAddress, isCityLine, isLabelNoise, looksLikeStreet, matchCounty, parseIrishAddress, type IrishAddress } from './irishAddress';

export const PHONE_RX = /\+?\d[\d\s\-()]{7,}\d/;
/** Phone numbers have 9-15 digits; shorter digit runs on labels are usually parcel IDs. */
export const isPhone = (text: string) => {
  const digits = text.match(PHONE_RX)?.[0].replace(/\D/g, '').length ?? 0;
  return digits >= 9 && digits <= 15;
};
export const PARCEL_RX = /^[A-Z0-9][A-Z0-9\-_/]{4,}$/i;

/** QR labels often wrap the ID in JSON or a tracking URL. */
export function unwrapCode(value: string) {
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value);
      const id = obj.parcelId ?? obj.trackingId ?? obj.tracking_id ?? obj.tracking ?? obj.awb ?? obj.id ?? obj.orderId;
      if (id) return String(id);
    } catch { /* not JSON */ }
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const param = ['parcelId', 'trackingId', 'tracking_id', 'tracking', 'awb', 'id', 'order'].map((k) => url.searchParams.get(k)).find(Boolean);
      return param ?? url.pathname.split('/').filter(Boolean).pop() ?? value;
    } catch { /* keep raw */ }
  }
  return value;
}

export const looksLikeAddress = (text: string) => text.length >= 8 && /[a-z]/i.test(text) && /\s/.test(text) && !/^https?:\/\//i.test(text);

/**
 * The lines of an address carried in a QR code. Labels separate the parts with new lines, commas,
 * pipes ("TEST-002|Eoin Doherty|155 Hillcrest Close|…") or semicolons.
 */
export const codeLines = (value: string) => value.split(/\r?\n|[|;\t]|,\s*/).map((l) => l.trim()).filter(Boolean);

/** A parcel ID as stored: compact and upper-case. */
export const cleanParcelId = (raw: string) => unwrapCode(raw.trim()).replace(/\s+/g, '').toUpperCase().slice(0, 80);

// A parcel ID is one or two words with a digit, and never an Eircode ("T45 XP21") or an address line.
const isParcelLine = (l: string) => PARCEL_RX.test(l.replace(/\s+/g, '')) && /\d/.test(l) && l.trim().split(/\s+/).length <= 2 && !findEircode(l);

/** Index of the OCR line most likely to be the parcel ID, or -1. */
export function findParcelLine(lines: string[]) {
  // Prefer IDs mixing letters and digits; fall back to digit-only codes that aren't phone numbers.
  const i = lines.findIndex((l) => isParcelLine(l) && /[a-z]/i.test(l));
  return i >= 0 ? i : lines.findIndex((l) => isParcelLine(l) && !isPhone(l));
}

// Words that show up in addresses (English and common Pakistani/Indian label wording).
const ADDRESS_HINT = /\b(house|h\s?no|plot|flat|apt|apartment|floor|street|st|road|rd|lane|gali|block|sector|phase|town|colony|avenue|ave|society|scheme|mohalla|mohallah|village|tehsil|district|city|near|opp|opposite|bazar|bazaar|market|chowk|plaza|tower|building|park|nagar)\b|#\s?\d|\bno\.?\s?\d/i;
const TO_LABEL = /^(ship\s*to|deliver\s*to|delivery\s*address|consignee|recipient|receiver|address|to)\b\s*[:\-.]?\s*/i;
const FROM_LABEL = /^(from|sender|shipper|return\s*(to|address))\b/i;
const NOISE = /^(cod|cash on delivery|weight|wt|pcs|qty|amount|rs\.?|pkr|order|tracking|awb|ref|date|service|origin|destination)\b/i;

const addressScore = (line: string) => {
  if (line.length < 6 || isPhone(line) || ID_LABEL.test(line) || FROM_LABEL.test(line) || NOISE.test(line) || isLabelNoise(line)) return 0;
  if (isParcelLine(line) && !/\s/.test(line.trim())) return 0;
  let score = 0;
  if (ADDRESS_HINT.test(line)) score += 2;
  if (/\d/.test(line) && /[a-z]{3,}/i.test(line)) score += 1;
  if (line.length >= 12 && /\s/.test(line)) score += 1;
  return score;
};

// A line that is only a person's name: 2-4 words of letters, nothing address-like.
const looksLikeName = (line: string) => /^[a-z][a-z.' ]{2,40}$/i.test(line) && line.trim().split(/\s+/).length <= 4 && !ADDRESS_HINT.test(line);

// "AWB: 123", "Tracking No. ABC123", "CN # 55-1" — an ID printed next to its name.
const ID_LABEL = /^(awb|tracking|track|cn|consignment|parcel|shipment|order|ref|reference)\s*(no\.?|number|id|#)?\s*[:#\-.]?\s*([A-Z0-9][A-Z0-9\-_/]{2,})\s*$/i;

export type LabelRead = {
  address: string | null; parcelId: string | null; phone: string | null; name: string | null;
  /** Irish address parts when the label has an Eircode or Irish town lines; null otherwise. */
  parts: IrishAddress | null;
  /** The OCR lines as read, kept for debugging and for the confirmation screen. */
  rawLines: string[];
};

/** Pulls the delivery address, parcel ID, phone and customer name out of the text on a label. */
export function readLabel(found: string[]): LabelRead {
  const lines = found.flatMap((block) => block.split('\n')).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
  // Labelled IDs are never phone numbers, and multi-word lines ("10 Downing Street") are never IDs.
  const labelledId = lines.map((l) => l.match(ID_LABEL)?.[3]).find(Boolean);
  const phoneLine = lines.find((l) => isPhone(l) && !ID_LABEL.test(l));
  const idCandidates = lines.filter((l) => l.split(' ').length <= 2);
  const parcelIndex = findParcelLine(idCandidates);
  const parcelId = labelledId || (parcelIndex >= 0 ? idCandidates[parcelIndex] : null);
  const result: LabelRead = {
    address: null,
    parcelId: parcelId ? cleanParcelId(parcelId) : null,
    phone: phoneLine ? (phoneLine.match(PHONE_RX)?.[0] ?? '').replace(/[^\d+\-() ]/g, '').trim() : null,
    name: null,
    parts: null,
    rawLines: lines,
  };

  // Irish labels: Eircode-anchored parsing is much more reliable than the generic guess below.
  const irish = parseIrishAddress(lines.filter((l) => !isPhone(l) && !ID_LABEL.test(l)));
  if ((irish.eircode || irish.confidence >= 0.55) && irish.street) {
    result.parts = irish;
    result.address = formatIrishAddress(irish);
    result.name = irish.recipient;
    // A parcel ID guess must not be one of the address lines.
    const addressText = [irish.building, irish.street, irish.area, irish.city].filter(Boolean).join(' ').toUpperCase().replace(/\s+/g, '');
    if (result.parcelId && addressText.includes(result.parcelId)) result.parcelId = labelledId ? cleanParcelId(labelledId) : null;
    return result;
  }

  // 1. A "To:" / "Ship to" block: the recipient name, then the address lines under it.
  const toIndex = lines.findIndex((l) => TO_LABEL.test(l));
  let start = -1;
  if (toIndex >= 0) {
    const rest = lines[toIndex].replace(TO_LABEL, '').trim();
    if (rest.length > 1) lines[toIndex] = rest; else start = toIndex + 1;
    if (start < 0) start = toIndex;
    if (lines[start] && looksLikeName(lines[start]) && addressScore(lines[start]) < 2) { result.name = lines[start]; start += 1; }
  }

  // 2. Otherwise the best-looking address line on the label.
  if (start < 0 || addressScore(lines[start] ?? '') === 0) {
    let best = -1;
    lines.forEach((l, i) => { if (addressScore(l) >= 2 && (best < 0 || addressScore(l) > addressScore(lines[best]))) best = i; });
    if (best < 0) return result;
    start = best;
  }

  // Addresses usually run over 2-3 lines; keep following lines while they still look like address.
  const parts: string[] = [];
  for (let i = start; i < lines.length && parts.length < 3; i += 1) {
    if (FROM_LABEL.test(lines[i]) || TO_LABEL.test(lines[i])) break;
    if (lines[i] === result.name) continue;
    if (addressScore(lines[i]) === 0) { if (parts.length) break; continue; }
    parts.push(lines[i]);
  }
  const address = parts.join(', ').replace(/,\s*,/g, ',').slice(0, 400);
  if (looksLikeAddress(address)) result.address = address;
  return result;
}

/** The fields the scanner shows, lets the rider edit and saves. */
export type FieldKey = 'name' | 'street' | 'city' | 'county' | 'postalCode' | 'country';
/** `low`: found, but worth a second look (guessed, or OCR look-alikes repaired). */
export type FieldConfidence = 'high' | 'low' | 'missing';

/** What the scanner shows and saves from a label: recipient, address parts and postcode only. */
export type LabelFields = {
  name: string | null;
  /** Building, street and area lines. */
  street: string | null;
  city: string | null;
  county: string | null;
  /** The Eircode, or a UK postcode on labels without one. */
  postalCode: string | null;
  country: string | null;
  confidence: Record<FieldKey, FieldConfidence>;
};

const join = (parts: (string | null | undefined)[]) => parts.map((p) => p?.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
/** The address lines without the postcode, for display. */
export const fieldsAddress = (f: Pick<LabelFields, 'street' | 'city' | 'county' | 'country'>) => join([f.street, f.city, f.county, f.country]);
/** The full address as saved and geocoded (with the postcode). */
export const composeAddress = (f: Pick<LabelFields, 'street' | 'city' | 'county' | 'postalCode' | 'country'>) => join([f.street, f.city, f.county, f.postalCode, f.country]);

const level = (value: string | null, high: boolean): FieldConfidence => (!value ? 'missing' : high ? 'high' : 'low');

export function labelFields(read: LabelRead): LabelFields {
  const p = read.parts;
  if (p) {
    const street = join([p.building, p.street, p.area]) || null;
    const knownCounty = p.county ? matchCounty(p.county.replace(/^\S+\s+/, '')) : null;
    return {
      name: p.recipient ?? read.name,
      street,
      city: p.city,
      county: p.county,
      postalCode: p.eircode,
      country: p.country,
      confidence: {
        name: level(p.recipient ?? read.name, p.quality.recipientAfterTo),
        street: level(street, !!p.street && looksLikeStreet(p.street)),
        city: level(p.city, !!p.city && isCityLine(p.city)),
        county: level(p.county, !!knownCounty && !p.quality.countyCorrected),
        postalCode: level(p.eircode, !p.quality.eircodeRepaired),
        country: level(p.country, true),
      },
    };
  }
  // Generic labels: the postcode can be on any line, so every line is searched, not just the address.
  const postalCode = (read.address && (findEircode(read.address) ?? findUkPostcode(read.address)))
    || read.rawLines.map((l) => findEircode(l) ?? findUkPostcode(l)).find(Boolean) || null;
  const parts = (read.address ?? '').split(', ').filter((part) => part && !(postalCode && part.toUpperCase().replace(/\s/g, '') === postalCode.replace(/\s/g, '')));
  const city = parts.length >= 2 ? parts.pop()! : null;
  const street = parts.join(', ') || null;
  return {
    name: read.name,
    street,
    city,
    county: null,
    postalCode,
    country: null,
    // Without Irish address structure every part is a guess.
    confidence: { name: level(read.name, false), street: level(street, false), city: level(city, false), county: 'missing', postalCode: level(postalCode, true), country: 'missing' },
  };
}

const KEYS: FieldKey[] = ['name', 'street', 'city', 'county', 'postalCode', 'country'];
const compact = (v: string | null) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Combines readings of the same label (e.g. the straightened crop first, then the whole photo):
 * the first reading's fields, with any it missed filled in from the others. When two readings agree
 * on the postcode it is trusted; when they disagree it is flagged for the rider to check.
 */
export function mergeFields(readings: LabelFields[]): LabelFields | null {
  if (!readings.length) return null;
  const out: LabelFields = { ...readings[0], confidence: { ...readings[0].confidence } };
  for (const other of readings.slice(1)) {
    for (const key of KEYS) {
      if (!out[key] && other[key]) { out[key] = other[key]; out.confidence[key] = other.confidence[key]; }
    }
    if (out.postalCode && other.postalCode) {
      if (compact(out.postalCode) === compact(other.postalCode)) out.confidence.postalCode = 'high';
      else if (other.confidence.postalCode === 'high' && out.confidence.postalCode !== 'high') { out.postalCode = other.postalCode; }
      else out.confidence.postalCode = 'low';
    }
  }
  return out;
}

/**
 * What makes two scans the same parcel: Eircode and recipient name together (so two parcels for
 * different people at one address are not mixed up), or the whole address when there's no Eircode.
 */
export function labelKey(f: Pick<LabelFields, 'name' | 'street' | 'city' | 'county' | 'postalCode' | 'country'>) {
  const name = (f.name ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (f.postalCode) return `eir:${f.postalCode.toUpperCase().replace(/\s/g, '')}|${name}`;
  return `txt:${composeAddress(f).toLowerCase().replace(/[^a-z0-9]/g, '')}|${name}`;
}

/** Number of fields found, with confident ones counting double: used to pick the better reading. */
export const fieldsScore = (f: LabelFields) => KEYS.reduce((sum, k) => sum + (f.confidence[k] === 'high' ? 2 : f.confidence[k] === 'low' ? 1 : 0), 0);
