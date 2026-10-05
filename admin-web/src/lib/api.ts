export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:4000';

export type ApiError = { code: string; message: string; details?: unknown[] };
export class ApiRequestError extends Error {
  code: string;
  status: number;
  details?: unknown[];
  constructor(status: number, error: ApiError) {
    super(error.message);
    this.code = error.code;
    this.status = status;
    this.details = error.details;
  }
}

let accessToken: string | null = sessionStorage.getItem('dp_admin_token');
let onUnauthorized: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
  if (token) sessionStorage.setItem('dp_admin_token', token);
  else sessionStorage.removeItem('dp_admin_token');
};
export const getAccessToken = () => accessToken;
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn; };

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ client: 'web' }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const payload = await res.json();
        setAccessToken(payload.data.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

type Options = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; isForm?: boolean; retry?: boolean };

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<{ data: T; meta?: { page: number; limit: number; total: number; pages: number }; totals?: unknown }> {
  const url = new URL(`${API_URL}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined;
  if (opts.isForm) body = opts.body as FormData;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }

  const res = await fetch(url, { method: opts.method || 'GET', headers, body, credentials: 'include' });

  if (res.status === 401 && opts.retry !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, { ...opts, retry: false });
    onUnauthorized?.();
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.success) {
    const error: ApiError = payload?.error || { code: 'UNKNOWN', message: `Request failed (${res.status})` };
    if (res.status === 401) onUnauthorized?.();
    throw new ApiRequestError(res.status, error);
  }
  return payload;
}

export const get = <T,>(path: string, query?: Options['query']) => api<T>(path, { query });
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
