// Irish address parsing for parcel labels and for showing saved addresses.
//
// An Eircode is a routing key (a letter + two digits, or D6W) and a four-character unique
// identifier, e.g. "D06 YP22". A well-formed Eircode is NOT proof the address exists: the map
// lookup (backend geocoding) still has to confirm it.

export type IrishAddress = {
  recipient: string | null;
  /** Apartment / unit / building lines, kept as printed. */
  building: string | null;
  street: string | null;
  area: string | null;
  city: string | null;
  county: string | null;
  eircode: string | null;
  country: string | null;
  /** 0-1: how complete and well-formed the parse looks. Not a guarantee. */
  confidence: number;
  issues: string[];
  /** How the parts were found, so the scanner can flag the ones worth a second look. */
  quality: { eircodeRepaired: boolean; recipientAfterTo: boolean; countyCorrected: boolean };
};

// Letters used in Eircodes (no B, G, I, J, L, M, O, Q, S, U, Z).
const EIR_LETTER = 'ACDEFHKNPRTVWXY';
const ROUTING_KEY = `(?:[${EIR_LETTER}]\\d{2}|D6W)`;
const UNIQUE_ID = `[0-9${EIR_LETTER}]{4}`;
const EIRCODE_RX = new RegExp(`(?:^|[^A-Z0-9])(${ROUTING_KEY})\\s?(${UNIQUE_ID})(?![A-Z0-9])`, 'i');
const EIRCODE_ONLY_RX = new RegExp(`^${ROUTING_KEY}\\s?${UNIQUE_ID}$`, 'i');

// Common OCR mix-ups. Each map is applied only where the Eircode format rules a character out, so a
// correct character is never changed: digits where a digit must be, letters only from EIR_LETTER.
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4' };
const FIRST_LETTER: Record<string, string> = { '0': 'D', O: 'D', Q: 'D', '4': 'A', M: 'N' };
// Unique-ID characters that can't be in an Eircode, to the valid character they're usually misread from.
const ID_CHAR: Record<string, string> = { O: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', U: 'V', J: '1', M: 'N' };

/** Fixes look-alikes in a 7-character token ("D0G YP22" → "D06YP22", "N37 YSVH" → "N37Y5VH"). */
function repairRoutingKey(token: string) {
  const t = token.toUpperCase().replace(/\s+/g, '');
  if (t.length !== 7) return t;
  if (t.startsWith('D6W')) return t.slice(0, 3) + [...t.slice(3)].map((ch) => ID_CHAR[ch] ?? ch).join('');
  return (FIRST_LETTER[t[0]] ?? t[0]) + (TO_DIGIT[t[1]] ?? t[1]) + (TO_DIGIT[t[2]] ?? t[2]) + [...t.slice(3)].map((ch) => ID_CHAR[ch] ?? ch).join('');
}

export type EircodeMatch = { code: string; /** True when OCR look-alikes had to be fixed: worth a second look. */ repaired: boolean };

/** The Eircode in a line of text, and whether it had to be repaired, or null. */
export function findEircodeDetail(text: string): EircodeMatch | null {
  const upper = text.toUpperCase();
  const direct = upper.match(EIRCODE_RX);
  if (direct) return { code: `${direct[1]} ${direct[2]}`, repaired: false };
  // Retry with OCR look-alikes repaired, on runs of one to three words that make 7 characters
  // ("A92 EDWE", "A92EDWE", "A9 2EDWE"); "VV" is a common misreading of "W".
  const words = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + 3); j += 1) {
      joined += words[j];
      const candidates = joined.length === 7 ? [joined] : joined.length === 8 && joined.includes('VV') ? [joined.replace('VV', 'W')] : [];
      for (const compact of candidates) {
        // At least one real digit in the routing key, so plain words ("DOLPHIN") aren't read as codes.
        if (!/\d/.test(compact.slice(1, 3))) continue;
        const repaired = repairRoutingKey(compact);
        if (EIRCODE_ONLY_RX.test(repaired)) return { code: `${repaired.slice(0, 3)} ${repaired.slice(3)}`, repaired: true };
      }
      if (joined.length >= 8) break;
    }
  }
  return null;
}

/** The Eircode in a line of text, formatted "D06 YP22", or null. */
export const findEircode = (text: string): string | null => findEircodeDetail(text)?.code ?? null;

// UK (and Northern Ireland, "BT") postcodes, for labels that have no Eircode.
const UK_POSTCODE_RX = /(?:^|[^A-Z0-9])(GIR\s?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?)\s?(\d[ABD-HJLNP-UW-Z]{2})(?![A-Z0-9])/i;

/** A UK postcode in a line of text, formatted "SW1A 1AA", or null. */
export function findUkPostcode(text: string): string | null {
  const m = text.toUpperCase().match(UK_POSTCODE_RX);
  return m ? `${m[1].replace(/\s/g, '')} ${m[2]}` : null;
}

// The 26 counties of Ireland and the 6 of Northern Ireland.
export const COUNTIES = ['CARLOW', 'CAVAN', 'CLARE', 'CORK', 'DONEGAL', 'DUBLIN', 'GALWAY', 'KERRY', 'KILDARE', 'KILKENNY', 'LAOIS', 'LEITRIM', 'LIMERICK', 'LONGFORD', 'LOUTH', 'MAYO', 'MEATH', 'MONAGHAN', 'OFFALY', 'ROSCOMMON', 'SLIGO', 'TIPPERARY', 'WATERFORD', 'WESTMEATH', 'WEXFORD', 'WICKLOW', 'ANTRIM', 'ARMAGH', 'DOWN', 'FERMANAGH', 'DERRY', 'LONDONDERRY', 'TYRONE'];

function editDistance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The county a (possibly misread) name is closest to, and how many letters differ; null if none is close. */
export function matchCounty(name: string): { county: string; distance: number } | null {
  const key = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (key.length < 4) return COUNTIES.includes(key) ? { county: key, distance: 0 } : null;
  let best: { county: string; distance: number } | null = null;
  for (const county of COUNTIES) {
    const distance = editDistance(key, county);
    if (!best || distance < best.distance) best = { county, distance };
  }
  // Two wrong letters at most, and fewer for short names, so "CO. LOUTN" fixes but "CO. BRAY" doesn't.
  return best && best.distance <= Math.min(2, Math.floor(key.length / 4)) ? best : null;
}

export const isEircode = (text: string) => EIRCODE_ONLY_RX.test(text.trim());

/** The line without its Eircode (also when OCR printed it with look-alike characters). */
function stripEircode(line: string, eircode: string) {
  const compact = eircode.replace(' ', '');
  const words = line.split(/\s+/);
  const key = (w: string) => w.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const matches = (t: string) => (t.length === 7 && repairRoutingKey(t) === compact) || (t.length === 8 && t.includes('VV') && repairRoutingKey(t.replace('VV', 'W')) === compact);
  for (let i = 0; i < words.length; i += 1) {
    if (matches(key(words[i]))) { words.splice(i, 1); break; }
    if (i + 1 < words.length && matches(key(words[i]) + key(words[i + 1]))) { words.splice(i, 2); break; }
  }
  return cleanLine(words.join(' '));
}

const DUBLIN_RX = /\bDUBLIN\s*(\d{1,2}W?)\b|\bD\s?(\d{1,2}W?)\b(?!\s?[0-9A-Z]{4})/i;
const COUNTY_RX = /^(?:C[O0](?:\.\s*|\s+)|COUNTY\s+)([A-Z][A-Z' -]+)$/i;
const COUNTRY_RX = /^(?:IRELAND|EIRE|ÉIRE|REPUBLIC OF IRELAND|ROI|IE)$/i;
// "TO" is often read as "T0" on a tilted label, and as "IO" / "1O" (only trusted with its colon).
const TO_LABEL = /^(?:(?:SHIP\s*TO|DELIVER\s*TO|DELIVERY\s*ADDRESS|CONSIGNEE|RECIPIENT|RECEIVER|T[O0])\b\s*[:;.\-]?|[I1l|][O0]\s*[:;])\s*/i;
const FROM_LABEL = /^(?:FROM|SENDER|SHIPPER|RETURN\s*(?:TO|ADDRESS))\b/i;
const BUILDING_RX = /^(?:APT|APARTMENT|FLAT|UNIT|SUITE|FLOOR|BLOCK|NO\.?\s*\d|\d+[A-Z]?\s*(?:THE|[A-Z]+\s+(?:HOUSE|COURT|HALL|MEWS|TOWERS?|APARTMENTS?|BUILDING|LODGE)))\b/i;
const STREET_WORDS = /\b(?:ROAD|RD|STREET|ST|AVENUE|AVE|LANE|LN|DRIVE|DR|PARK|GROVE|CRESCENT|CRES|TERRACE|TCE|SQUARE|SQ|PLACE|PL|WAY|CLOSE|COURT|CT|GARDENS|GDNS|HILL|QUAY|ROW|VIEW|WALK|GREEN|MEWS|VALE|HEIGHTS|DOWNS|LAWN|LAWNS|WOOD|WOODS|MANOR|RISE|BOULEVARD|BLVD)\b/i;
// Lines that are never part of an address: long digit runs (barcodes), sort codes, carrier names.
const NOISE_RX = /^(?:[A-Z]{2}-[A-Z]{3}|AN POST|DPD|GLS|UPS|FEDEX|DHL|FASTWAY|NIGHTLINE|PARCEL\s*MOTEL|TRACKING.*|AWB.*|REF.*|ORDER.*|WEIGHT.*|PCS.*|COD.*)$/i;

/** Collapses spaces and trims punctuation at the ends; keeps the line's own wording and case. */
export const cleanLine = (line: string) => line.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:|]+|[\s,;:|]+$/g, '').trim();

const isBarcodeText = (line: string) => /\d{8,}/.test(line.replace(/\s+/g, '')) && !/[A-Z]{3,}/i.test(line.replace(/\d/g, ''));
// Label furniture and sample-sheet wording ("PARCEL - OCR TEST SAMPLE"), never part of an address.
const HEADER_RX = /\b(?:PARCEL|SAMPLE|TEST|LABEL|POSTAGE\s+PAID)\b/i;
const digitCount = (text: string) => text.replace(/\D/g, '').length;
/**
 * A tracking or reference code ("TEST-002", "OCR966647391", "OCR 966647391"): letters and at least
 * three digits, where every word has a digit or is a short prefix. Never an Eircode or postcode, and
 * never a street line ("155 HILLCREST" has a real word).
 */
export function isTrackingCode(text: string) {
  const words = text.trim().split(/\s+/);
  if (!words[0] || words.length > 2 || !/[A-Z]/i.test(text) || digitCount(text) < 3) return false;
  if (!words.every((w) => /\d/.test(w) || /^[A-Z]{1,3}[-_/#:.]?$/i.test(w))) return false;
  return !findEircode(text) && !findUkPostcode(text);
}
// QR codes and barcodes read as text come out as mostly symbols.
const isGarbled = (line: string) => {
  const chars = line.replace(/\s+/g, '');
  return chars.length > 0 && chars.replace(/[^A-Z0-9]/gi, '').length / chars.length < 0.6;
};
/** Lines that are never part of the delivery address: headers, carrier names, tracking codes, barcodes. */
export const isLabelNoise = (line: string) => !line || NOISE_RX.test(line) || HEADER_RX.test(line) || isBarcodeText(line) || isTrackingCode(line) || isGarbled(line) || /^https?:/i.test(line);
const isNoise = isLabelNoise;
/** The line without codes that OCR ran into it ("EOIN DOHERTY TEST-002" → "EOIN DOHERTY"). */
const dropCodeWords = (line: string) => {
  const words = line.split(' ');
  // Short codes are left alone: they may be half of an Eircode ("K67 R165") or a unit number.
  if (words.length < 2 || findEircode(line) || findUkPostcode(line)) return line;
  return words.filter((w) => !(w.length >= 6 && isTrackingCode(w))).join(' ');
};
const looksLikeName = (line: string) => /^[A-Z][A-Z.'’ -]{2,40}$/i.test(line) && line.split(' ').length <= 4 && !STREET_WORDS.test(line) && !COUNTRY_RX.test(line) && !DUBLIN_RX.test(line);
/** A street line: a house number, or a street word ("HILLCREST CLOSE"). */
export const looksLikeStreet = (line: string) => /^\d+[A-Z]?\b/i.test(line) || STREET_WORDS.test(line);
export const isCityLine = (line: string) => DUBLIN_RX.test(line) || /^[A-Z][A-Z' -]{2,30}(?:\s+\d{1,2}W?)?$/i.test(line);

/**
 * Parses label lines (in reading order) into Irish address parts. Returns nulls for parts it can't
 * find rather than guessing; `issues` says what's missing.
 */
export function parseIrishAddress(input: string[]): IrishAddress {
  const lines = input.map((l) => cleanLine(dropCodeWords(cleanLine(l)))).filter((l) => l.length > 0);
  const out: IrishAddress = {
    recipient: null, building: null, street: null, area: null, city: null, county: null, eircode: null, country: null, confidence: 0, issues: [],
    quality: { eircodeRepaired: false, recipientAfterTo: false, countyCorrected: false },
  };

  // 1. Where the address starts: after a "TO:" label if there is one.
  let start = 0;
  const toAt = lines.findIndex((l) => TO_LABEL.test(l));
  if (toAt >= 0) {
    const rest = cleanLine(lines[toAt].replace(TO_LABEL, ''));
    if (rest) lines[toAt] = rest; else lines.splice(toAt, 1);
    start = toAt;
  }

  // 2. Where it ends: the Eircode / country line (or a FROM block). The Eircode is looked for on
  //    every line, because a tilted label's lines can come back out of order; one after the TO
  //    label is preferred, and a cleanly read one over one with repaired look-alikes.
  let end = lines.length;
  const found = lines.map((l, i) => ({ i, m: findEircodeDetail(l) })).filter((f): f is { i: number; m: EircodeMatch } => !!f.m);
  const pick = found.find((f) => f.i >= start && !f.m.repaired) ?? found.find((f) => f.i >= start) ?? found.find((f) => !f.m.repaired) ?? found[0];
  const eirAt = pick ? pick.i : -1;
  if (pick) {
    out.eircode = pick.m.code;
    out.quality.eircodeRepaired = pick.m.repaired;
    // Anything else on the Eircode line (e.g. "DUBLIN 6 D06 YP22") is kept as a separate part.
    lines[eirAt] = stripEircode(lines[eirAt], out.eircode);
    if (eirAt >= start) end = eirAt + 1;
  }
  for (let i = start; i < lines.length; i += 1) {
    if (FROM_LABEL.test(lines[i]) && i > start) { end = Math.min(end, i); break; }
  }
  if (eirAt >= start && end < lines.length && COUNTRY_RX.test(lines[end] ?? '')) { out.country = lines[end]; }

  // Without a TO label, walk upwards from the Eircode / Dublin line to the recipient's name.
  if (toAt < 0) {
    // The Eircode line, or (when it was read out of order, e.g. first) the county / Dublin / country
    // line: whichever has a street line within the six lines above it.
    const anchors = [eirAt, lines.findIndex((l) => COUNTY_RX.test(l)), lines.findIndex((l) => DUBLIN_RX.test(l)), lines.findIndex((l) => COUNTRY_RX.test(l))].filter((i) => i >= 0);
    const hasStreetAbove = (a: number) => lines.slice(Math.max(0, a - 6), a).some((l) => looksLikeStreet(l) || BUILDING_RX.test(l));
    const anchor = anchors.find(hasStreetAbove) ?? anchors[0] ?? -1;
    if (anchor >= 0) {
      // Up to six lines above the anchor, stopping at carrier text, barcodes or a FROM block.
      let i = anchor - 1;
      while (i >= 0 && anchor - i <= 6 && !isNoise(lines[i]) && !FROM_LABEL.test(lines[i])) i -= 1;
      start = Math.max(0, i + 1);
      // The recipient is the name line right above the first street / building line; drop what's above it.
      const firstAddress = lines.findIndex((l, k) => k >= start && k <= anchor && (BUILDING_RX.test(l) || /^\d+[A-Z]?\b/i.test(l) || STREET_WORDS.test(l)));
      if (firstAddress > start) {
        const nameAt = firstAddress - 1;
        start = looksLikeName(lines[nameAt]) && !/\d/.test(lines[nameAt]) ? nameAt : firstAddress;
      }
      end = Math.max(end === lines.length ? anchor + 1 : end, anchor + 1);
    } else {
      end = lines.length;
    }
  }

  const block = lines.slice(start, end).filter((l) => l && !isNoise(l));

  // 3. Classify the block, top to bottom.
  const rest: string[] = [];
  for (const line of block) {
    if (COUNTRY_RX.test(line)) { out.country = out.country ?? line; continue; }
    const county = line.match(COUNTY_RX);
    if (county) {
      // A misread county name ("CO. LOUTN") is put right; one printed correctly is kept as printed.
      const known = matchCounty(county[1]);
      out.county = known && known.distance > 0 ? `CO. ${known.county}` : line;
      out.quality.countyCorrected = !!known && known.distance > 0;
      continue;
    }
    // The line right after "TO:" is the name even when OCR put a digit in it ("E0IN DOHERTY"),
    // as long as it isn't the street; such a name is flagged for a second look.
    const afterTo = toAt >= 0 && line === block[0];
    const nameLine = (looksLikeName(line) && !/\d/.test(line)) || (afterTo && !looksLikeStreet(line) && !BUILDING_RX.test(line) && !DUBLIN_RX.test(line));
    if (!out.recipient && !out.street && !out.building && nameLine) {
      out.recipient = line;
      out.quality.recipientAfterTo = afterTo && !/\d/.test(line);
      continue;
    }
    if (!out.street && BUILDING_RX.test(line) && !STREET_WORDS.test(line)) { out.building = out.building ? `${out.building}, ${line}` : line; continue; }
    if (!out.street && (/^\d+[A-Z]?\b/i.test(line) || STREET_WORDS.test(line))) { out.street = line; continue; }
    rest.push(line);
  }
  // The last remaining line is the town/city (or Dublin district); lines before it are the area.
  if (rest.length) {
    const cityIdx = rest.map((l, i) => (DUBLIN_RX.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? rest.length - 1;
    if (isCityLine(rest[cityIdx]) || DUBLIN_RX.test(rest[cityIdx])) {
      out.city = rest[cityIdx];
      const before = rest.filter((_, i) => i !== cityIdx);
      if (!out.street && before.length) out.street = before.shift()!;
      if (before.length) out.area = before.join(', ');
    } else if (!out.street) {
      out.street = rest.shift()!;
      if (rest.length) out.area = rest.join(', ');
    } else {
      out.area = rest.join(', ');
    }
  }

  // 4. How much to trust it.
  if (out.eircode) out.confidence += 0.35; else out.issues.push('Missing Eircode');
  if (out.street) out.confidence += /\d/.test(out.street) ? 0.25 : 0.15; else out.issues.push('No street line found');
  if (out.city || out.county) out.confidence += 0.2; else out.issues.push('No town or city found');
  if (out.recipient) out.confidence += 0.1;
  if (out.area || out.building) out.confidence += 0.1;
  out.confidence = Math.min(1, Math.round(out.confidence * 100) / 100);
  return out;
}

/** The parts as one address string for saving and geocoding (comma-separated, spaces preserved). */
export function formatIrishAddress(a: Pick<IrishAddress, 'building' | 'street' | 'area' | 'city' | 'county' | 'eircode' | 'country'>) {
  return [a.building, a.street, a.area, a.city, a.county, a.eircode, a.country].map((p) => (p ? cleanLine(p) : '')).filter(Boolean).join(', ');
}

/** Splits a saved address into display lines and its Eircode, for delivery cards. */
export function splitForDisplay(raw: string): { first: string; rest: string; eircode: string | null } {
  const parts = raw.split(',').map(cleanLine).filter(Boolean);
  let eircode: string | null = null;
  const kept = parts.filter((p) => {
    if (!eircode && isEircode(p)) { eircode = findEircode(p); return false; }
    return true;
  });
  if (!eircode) {
    // An Eircode at the end of a part ("DUBLIN 6 D06 YP22").
    for (let i = kept.length - 1; i >= 0 && !eircode; i -= 1) {
      const found = findEircode(kept[i]);
      if (found) { eircode = found; kept[i] = stripEircode(kept[i], found); }
    }
  }
  const visible = kept.filter((p) => p && !COUNTRY_RX.test(p));
  return { first: visible[0] ?? raw, rest: visible.slice(1).join(', '), eircode };
}

/**
 * A key for spotting the same address twice (e.g. the same label scanned again): the Eircode when
 * there is one, otherwise the address reduced to letters and digits.
 */
export function addressKey(raw: string) {
  const eircode = findEircode(raw);
  return eircode ? `eir:${eircode.replace(' ', '')}` : `txt:${raw.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}
