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

/** "Today", "Tomorrow" or "Mon 20 Oct" for a date key. */
export const dayLabel = (key: string) => {
  if (key === dayKey(0)) return 'Today';
  if (key === dayKey(1)) return 'Tomorrow';
  return fromDayKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
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
