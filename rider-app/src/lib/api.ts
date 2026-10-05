import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheDirectory, copyAsync, deleteAsync, FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');

export type ApiErrorShape = { code: string; message: string; details?: unknown[] };
export class ApiRequestError extends Error {
  code: string;
  status: number;
  details?: unknown[];
  constructor(status: number, error: ApiErrorShape) {
    super(error.message);
    this.code = error.code;
    this.status = status;
    this.details = error.details;
  }
}

const TOKENS_KEY = 'dp_rider_tokens_v1';
type Tokens = { accessToken: string; refreshToken: string } | null;
let tokens: Tokens = null;
let ready: Promise<void> | null = null;
let onAuthChange: ((tokens: Tokens) => void) | null = null;

export const setAuthChangeHandler = (fn: ((tokens: Tokens) => void) | null) => { onAuthChange = fn; };

async function loadTokens() {
  if (!ready) {
    ready = AsyncStorage.getItem(TOKENS_KEY).then((raw) => {
      tokens = raw ? JSON.parse(raw) : null;
    }).catch(() => { tokens = null; });
  }
  return ready;
}

export async function setTokens(next: Tokens) {
  tokens = next;
  onAuthChange?.(next);
  if (next) await AsyncStorage.setItem(TOKENS_KEY, JSON.stringify(next));
  else await AsyncStorage.removeItem(TOKENS_KEY);
}

export async function getTokens() {
  await loadTokens();
  return tokens;
}

let refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  await loadTokens();
  if (!tokens?.refreshToken) return false;
  if (!refreshing) {
    refreshing = fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken, client: 'mobile' }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const payload = await res.json();
        await setTokens({ accessToken: payload.data.accessToken, refreshToken: payload.data.refreshToken });
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

type Options = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; isForm?: boolean; retry?: boolean };

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<{ data: T; meta?: { page: number; limit: number; total: number; pages: number } }> {
  await loadTokens();
  const url = new URL(`${API_URL}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {};
  if (tokens?.accessToken) headers.Authorization = `Bearer ${tokens.accessToken}`;
  let body: BodyInit | undefined;
  if (opts.isForm) body = opts.body as FormData;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }

  const res = await fetch(url.toString(), { method: opts.method || 'GET', headers, body });

  if (res.status === 401 && opts.retry !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, { ...opts, retry: false });
    await setTokens(null);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.success) {
    const error: ApiErrorShape = payload?.error || { code: 'UNKNOWN', message: `Request failed (${res.status})` };
    throw new ApiRequestError(res.status, error);
  }
  return payload;
}

export const get = <T,>(path: string, query?: Options['query']) => api<T>(path, { query });
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });

export async function postFile<T>(path: string, fileUri: string, fieldName: string, mimeType: string) {
  await loadTokens();
  if (!cacheDirectory) throw new Error('The app cache directory is unavailable');

  const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
  const stagedUri = `${cacheDirectory}upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  await copyAsync({ from: fileUri, to: stagedUri });
  const url = `${API_URL}/api/v1${path}`;
  try {
    const send = () => uploadAsync(url, stagedUri, {
      httpMethod: 'POST',
      uploadType: FileSystemUploadType.MULTIPART,
      fieldName,
      mimeType,
      headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {},
    });

    let response = await send();
    if (response.status === 401) {
      if (await tryRefresh()) response = await send();
      else await setTokens(null);
    }

    let payload: { success?: boolean; data?: T; meta?: { page: number; limit: number; total: number; pages: number }; error?: ApiErrorShape } | null = null;
    try { payload = JSON.parse(response.body); } catch { /* handled as an unknown API response below */ }
    if (response.status < 200 || response.status >= 300 || !payload?.success) {
      throw new ApiRequestError(response.status, payload?.error || { code: 'UNKNOWN', message: `Request failed (${response.status})` });
    }
    return { data: payload.data as T, meta: payload.meta };
  } finally {
    await deleteAsync(stagedUri, { idempotent: true }).catch(() => {});
  }
}

/** Resolves a signed /files/... path from the API into a fetchable absolute URL with the bearer token attached via header — used for <Image> we fetch-and-blob, and for opening PDFs. */
export const fileUrl = (path: string) => `${API_URL}${path}`;
export const authHeader = () => (tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {});
