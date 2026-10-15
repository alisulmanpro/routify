export const money = (amount: number | null | undefined, currency?: string | null) =>
  amount == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(amount);

export const titleCase = (value: string) => value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const shortDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
export const timeOnly = (value: string | null | undefined) => (value ? new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
export const todayKey = () => new Date().toISOString().slice(0, 10);

export const FAILURE_LABELS: Record<string, string> = {
  customer_unavailable: 'Customer unavailable', customer_refused: 'Customer refused', wrong_address: 'Wrong address',
  phone_unreachable: 'Phone unreachable', business_closed: 'Business closed', other: 'Other',
};

/** "45 min" or "1 h 20 min". */
export const formatMinutes = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
