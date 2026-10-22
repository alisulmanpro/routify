import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { secureDelete, secureGet, secureSet } from './secureStorage';
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

/**
 * A request that got no answer: no connection, or it timed out. It is a TypeError, like fetch's own network failure,
 * so screens that tell "offline" apart from API errors (`err instanceof TypeError`) keep working.
 */
export class NetworkError extends TypeError {
  timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.name = 'NetworkError';
    this.timedOut = timedOut;
  }
}

/** The caller cancelled the request (e.g. a newer search replaced it). Not an error to show, never retried. */
export class RequestCancelled extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'RequestCancelled';
  }
}

// ---- Connection state (NetInfo) ----

let online = true;
const onlineListeners = new Set<(online: boolean) => void>();
NetInfo.addEventListener((state) => {
  // Only a definite "not connected" counts as offline; unknown reachability still tries the request.
  const next = state.isConnected !== false;
  if (next !== online) {
    online = next;
    onlineListeners.forEach((fn) => fn(next));
  }
});
export const isOnline = () => online;
/** Calls `fn` whenever the phone goes on- or offline; returns the unsubscribe function. */
export const onOnlineChange = (fn: (online: boolean) => void) => { onlineListeners.add(fn); return () => { onlineListeners.delete(fn); }; };

// ---- Timeouts and retries ----

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const RETRIES = 2;
const RETRY_STATUSES = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 0.5 s, then 1 s (± 25 %), so many phones coming back online do not retry in step. */
const backoff = (attempt: number) => 500 * 2 ** attempt * (0.75 + Math.random() * 0.5);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, cancel?: AbortSignal): Promise<Response> {
  if (cancel?.aborted) throw new RequestCancelled();
  if (!online) throw new NetworkError('No internet connection');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  cancel?.addEventListener('abort', onCancel);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (cancel?.aborted) throw new RequestCancelled();
    if (controller.signal.aborted) throw new NetworkError('The server took too long to answer', true);
    throw new NetworkError(err instanceof Error ? err.message : 'Network request failed');
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
  }
}

const TOKENS_KEY = 'dp_rider_tokens_v1';
type Tokens = { accessToken: string; refreshToken: string } | null;
let tokens: Tokens = null;
let ready: Promise<void> | null = null;
let onAuthChange: ((tokens: Tokens) => void) | null = null;

export const setAuthChangeHandler = (fn: ((tokens: Tokens) => void) | null) => { onAuthChange = fn; };

// The session lives in the secure store (P3.11). Riders signed in before that had it in AsyncStorage: it is moved over
// once, so nobody is signed out by the update.
async function readTokens(): Promise<Tokens> {
  let raw = await secureGet(TOKENS_KEY);
  if (!raw) {
    const legacy = await AsyncStorage.getItem(TOKENS_KEY);
    if (legacy) {
      await secureSet(TOKENS_KEY, legacy);
      await AsyncStorage.removeItem(TOKENS_KEY);
      raw = legacy;
    }
  }
  return raw ? JSON.parse(raw) : null;
}

async function loadTokens() {
  if (!ready) ready = readTokens().then((t) => { tokens = t; }).catch(() => { tokens = null; });
  return ready;
}

export async function setTokens(next: Tokens) {
  tokens = next;
  onAuthChange?.(next);
  if (next) await secureSet(TOKENS_KEY, JSON.stringify(next));
  else await Promise.all([secureDelete(TOKENS_KEY), AsyncStorage.removeItem(TOKENS_KEY)]);
}

export async function getTokens() {
  await loadTokens();
  return tokens;
}

/** ok: new tokens · rejected: the session is over (sign out) · unreachable: no answer, try again later (stay signed in). */
type Refresh = 'ok' | 'rejected' | 'unreachable';
let refreshing: Promise<Refresh> | null = null;
async function tryRefresh(): Promise<Refresh> {
  await loadTokens();
  if (!tokens?.refreshToken) return 'rejected';
  if (!refreshing) {
    refreshing = fetchWithTimeout(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken, client: 'mobile' }),
    }, READ_TIMEOUT_MS)
      .then(async (res): Promise<Refresh> => {
        if (res.status >= 500) return 'unreachable';
        if (!res.ok) return 'rejected';
        const payload = await res.json();
        await setTokens({ accessToken: payload.data.accessToken, refreshToken: payload.data.refreshToken });
        return 'ok';
      })
      // No connection while renewing must not sign the rider out (P3.11).
      .catch((): Refresh => 'unreachable')
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

type Options = {
  method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; isForm?: boolean; retry?: boolean;
  headers?: Record<string, string>;
  /** Safe to send twice (e.g. it carries an Idempotency-Key or client ids): retried after a network error or 502-504. GETs always are. */
  idempotent?: boolean;
  timeoutMs?: number;
  /** Aborting it cancels the request (it then rejects with RequestCancelled). */
  signal?: AbortSignal;
};
type Payload<T> = { data: T; meta?: { page: number; limit: number; total: number; pages: number } };

/** "/v2/..." goes to /api/v2, everything else to /api/v1. */
const urlFor = (path: string) => `${API_URL}${path.startsWith('/v2/') ? '/api' : '/api/v1'}${path}`;

async function send(path: string, opts: Options): Promise<Response> {
  await loadTokens();
  const url = new URL(urlFor(path));
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));

  const method = opts.method || 'GET';
  const repeatable = method === 'GET' || !!opts.idempotent || !!opts.headers?.['Idempotency-Key'];
  const timeoutMs = opts.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { ...opts.headers };
    if (tokens?.accessToken) headers.Authorization = `Bearer ${tokens.accessToken}`;
    let body: BodyInit | undefined;
    if (opts.isForm) body = opts.body as FormData;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    try {
      const res = await fetchWithTimeout(url.toString(), { method, headers, body }, timeoutMs, opts.signal);
      if (repeatable && RETRY_STATUSES.has(res.status) && attempt < RETRIES) { await sleep(backoff(attempt)); continue; }
      return res;
    } catch (err) {
      // Offline: fail at once. Otherwise retry what is safe to repeat; a write without a key is never sent twice.
      if (!(err instanceof NetworkError) || !repeatable || !online || attempt >= RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
}

async function parse<T>(res: Response): Promise<Payload<T>> {
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.success) {
    const error: ApiErrorShape = payload?.error || { code: 'UNKNOWN', message: `Request failed (${res.status})` };
    throw new ApiRequestError(res.status, error);
  }
  return payload;
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<Payload<T>> {
  const res = await send(path, opts);
  if (res.status === 401 && opts.retry !== false) {
    const refresh = await tryRefresh();
    if (refresh === 'ok') return api<T>(path, { ...opts, retry: false });
    if (refresh === 'unreachable') throw new NetworkError('Could not renew your session');
    await setTokens(null);
  }
  return parse<T>(res);
}

/** GET with an ETag: `notModified` (and no data) when the server says the copy sent as `etag` is still current. */
export async function getWithEtag<T>(path: string, etag?: string | null, retried = false): Promise<{ data?: T; etag: string | null; notModified: boolean }> {
  const res = await send(path, { headers: etag ? { 'If-None-Match': etag } : undefined });
  if (res.status === 401 && !retried) {
    const refresh = await tryRefresh();
    if (refresh === 'ok') return getWithEtag<T>(path, etag, true);
    if (refresh === 'unreachable') throw new NetworkError('Could not renew your session');
    await setTokens(null);
  }
  if (res.status === 304) return { etag: res.headers.get('etag') || etag || null, notModified: true };
  const payload = await parse<T>(res);
  return { data: payload.data, etag: res.headers.get('etag'), notModified: false };
}

/** A new random id for an Idempotency-Key or a stop's clientId. */
export { randomUUID as newId } from 'expo-crypto';

export const get = <T,>(path: string, query?: Options['query']) => api<T>(path, { query });
export const post = <T,>(path: string, body?: unknown, signal?: AbortSignal) => api<T>(path, { method: 'POST', body, signal });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });

/** Uploads a local file. Pass `fileName` for documents: the server reads the type from its extension. */
export async function postFile<T>(path: string, fileUri: string, fieldName: string, mimeType: string, fileName?: string, extraHeaders: Record<string, string> = {}) {
  await loadTokens();
  if (!cacheDirectory) throw new Error('The app cache directory is unavailable');

  const named = fileName?.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase();
  const extension = named || (mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg');
  const stagedUri = `${cacheDirectory}upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  await copyAsync({ from: fileUri, to: stagedUri });
  const url = urlFor(path);
  try {
    if (!online) throw new NetworkError('No internet connection');
    const send = () => uploadAsync(url, stagedUri, {
      httpMethod: 'POST',
      uploadType: FileSystemUploadType.MULTIPART,
      fieldName,
      mimeType,
      headers: { ...extraHeaders, ...(tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {}) },
    });

    // A failed upload (no connection, dropped) is a NetworkError like any other request, so it is retried, not reported.
    const sendOrOffline = () => send().catch((err: unknown) => { throw new NetworkError(err instanceof Error ? err.message : 'Upload failed'); });
    let response = await sendOrOffline();
    if (response.status === 401) {
      const refresh = await tryRefresh();
      if (refresh === 'ok') response = await sendOrOffline();
      else if (refresh === 'unreachable') throw new NetworkError('Could not renew your session');
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
