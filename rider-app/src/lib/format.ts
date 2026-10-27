import { expandForSearch } from './scan/address';

export const money = (amount: number | null | undefined, currency?: string | null) =>
  amount == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(amount);

export const titleCase = (value: string) => value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const shortDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
export const timeOnly = (value: string | null | undefined) => (value ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
/** "2026-10-18" for a date on the phone's own clock, not UTC. */
export const toDayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The local date of a "2026-10-18" key (midnight on the phone's clock; never parsed as UTC). */
export const fromDayKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
/** The key for today (or `days` from today) on the phone's own clock. */
export const dayKey = (days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDayKey(d);
};
export const todayKey = () => dayKey(0);

/** The name a route gets when the rider leaves it blank: a date, not "Tomorrow", so it still reads right on the day. */
export const defaultRouteName = (key: string) =>
  `Route · ${fromDayKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;

/** "Today", "Tomorrow" or "Mon 20 Oct" for a date key. */
export const dayLabel = (key: string) => {
  if (key === dayKey(0)) return 'Today';
  if (key === dayKey(1)) return 'Tomorrow';
  return fromDayKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

// ---- Eircodes (Irish postcodes); the API applies the same rules ----

// Routing key (D01, D6W) + 4-character unique id, in any case, with or without a space or dash between them.
const EIRCODE = /\b([AC-FHKNPRTV-Y]\d{2}|D6W)[\s-]?([0-9AC-FHKNPRTV-Y]{4})\b/i;
const EIRCODES = new RegExp(EIRCODE.source, 'gi');

/** The Eircode in some text, written "D01 F5P2", or null. */
export const findEircode = (text: string | null | undefined) => {
  const m = EIRCODE.exec(text || '');
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null;
};
/** The text with every Eircode written "D01 F5P2" ("d01f5p2", "D01-F5P2" and "d01 f5p2" all become that). */
export const normalizeEircodes = (text: string) => text.replace(EIRCODES, (_, key: string, id: string) => `${key} ${id}`.toUpperCase());
/** True when the text is just an Eircode (optionally with "Ireland"): there is no street in it. */
export const isOnlyEircode = (text: string) =>
  !!findEircode(text) && !text.replace(EIRCODES, ' ').replace(/\b(ireland|eire)\b|éire|[\s,.;:/-]+/gi, '');

// Short forms written out first, so "Church St, Co. Offaly" and "Church Street, County Offaly" count as the same text.
const comparable = (text: string) => expandForSearch(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The address without its postcode or a trailing "Ireland", for the line under the postcode. */
const withoutPostcode = (text: string, code: string | null) => {
  let out = text.replace(EIRCODES, '');
  if (code) out = out.split(code).join('');
  return out.replace(/,\s*(ireland|éire|eire)\s*$/i, '').replace(/(\s*,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
};

/**
 * A stop card's text: the postcode as the title, then the address (after a place name the rider typed, such as
 * "Department Of Justice", when the address the map found does not already start with it). Without a postcode the
 * address is the title and `address` is empty, so nothing shows twice.
 */
export const stopCardText = (d: { address: { raw: string; normalized: string | null; postalCode?: string | null } }) => {
  const { raw, normalized } = d.address;
  // Stops saved before postcodes were kept still show an Eircode found in their text.
  const code = d.address.postalCode || findEircode(raw) || findEircode(normalized);
  const typed = isOnlyEircode(raw) ? '' : withoutPostcode(raw, code);
  const found = normalized && comparable(normalized) !== comparable(raw) ? withoutPostcode(normalized, code) : '';
  const place = typed && found && !comparable(found).includes(comparable(typed)) ? typed : '';
  const address = [place, found || typed].filter(Boolean).join(', ');
  return code ? { title: code, address } : { title: address || raw, address: '' };
};

/** How a stop is named in lists: the customer, else the parcel ID, else the first part of its address. */
export const stopLabel = (d: { trackingId: string; customer: { name: string }; address: { raw: string } }) =>
  d.customer.name || (d.trackingId ? `Parcel ${d.trackingId}` : d.address.raw.split(',')[0].trim() || d.address.raw);

export const FAILURE_LABELS: Record<string, string> = {
  customer_unavailable: 'Customer unavailable', customer_refused: 'Customer refused', wrong_address: 'Wrong address',
  phone_unreachable: 'Phone unreachable', business_closed: 'Business closed', other: 'Other',
};

/** "45 min" or "1 h 20 min". */
export const formatMinutes = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
