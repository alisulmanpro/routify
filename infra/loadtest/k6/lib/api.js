/**
 * Thin API client for the load tests. Every response uses the app's envelope:
 *   success: { success: true, data: {...} }
 *   failure: { success: false, error: { code, message, details } }
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { apiUrl } from './staging.js';

export const V1 = '/api/v1';
export const V2 = '/api/v2';

/** k6 has no crypto.randomUUID; build a UUID-shaped string (the server only checks the shape). */
export function uuid(seed) {
  let s = (seed === undefined ? Math.random() * 1e9 : seed).toString(16);
  while (s.length < 32) s += '0123456789abcdef'[s.length % 16];
  return (
    s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' +
    s.slice(16, 20) + '-' + s.slice(20, 32)
  );
}

export function rid(base, path, token, params, tags) {
  const url = apiUrl(base, path);
  const res = http.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    params: params || {},
    tags: tags || {},
  });
  return wrap(res);
}

export function post(base, path, token, body, extraHeaders, tags) {
  const url = apiUrl(base, path);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const k in extraHeaders || {}) headers[k] = extraHeaders[k];
  const res = http.post(url, JSON.stringify(body), { headers, tags: tags || {} });
  return wrap(res);
}

export function wrap(res) {
  let body = null;
  try {
    body = res.json();
  } catch (e) {
    body = null;
  }
  const data = body && body.success ? body.data : null;
  const error = body && body.success === false ? body.error : null;
  return { status: res.status, body, data, error, headers: res.headers, res };
}

/** One stop for the synthetic Dublin addresses the scenarios use. */
export function makeStop(i, prefix) {
  const lat = 53.30 + ((i * 37) % 1000) / 10000; // 53.3000 .. 53.3999
  const lng = -6.30 + ((i * 53) % 1000) / 10000; // -6.3000 .. -6.2001
  return {
    clientId: uuid(i * 7919 + 13),
    trackingId: `${prefix || 'LT'}-${i}-${Math.floor(Math.random() * 1e6)}`,
    customer: { name: `Load Test ${i}` },
    address: { raw: `${i} Load Test Street, Dublin 1, D01 AB${String(i % 100).padStart(2, '0')}` },
    location: { latitude: lat, longitude: lng },
  };
}

/** POST /api/v2/deliveries/batch, chunked to the server's 500-item limit. */
export function createStops(base, token, prefix, count) {
  const created = [];
  for (let done = 0; done < count; done += 500) {
    const size = Math.min(500, count - done);
    const items = [];
    for (let i = 0; i < size; i++) items.push(makeStop(done + i, prefix));
    const r = post(base, `${V2}/deliveries/batch`, token, { items }, null, { name: 'create_stops' });
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`createStops failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const s of (r.data && r.data.stops) || []) created.push(s);
  }
  return created;
}

/** POST /api/v1/routes/build (the rider's own pending stops, no ids needed). */
export function buildRoute(base, token, preference) {
  const r = post(base, `${V1}/routes/build`, token, { preference: preference || 'smart' }, null, {
    name: 'build_route',
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`buildRoute failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.data;
}

export function startRoute(base, token, routeId) {
  return post(base, `${V1}/routes/${routeId}/start`, token, {}, null, { name: 'start_route' });
}

/** The app's one-request stop action: POST /api/v2/stops/{id}/events. */
export function stopEvent(base, token, stopId, type, idemKey, extra) {
  const body = Object.assign({ type }, extra || {});
  return post(
    base,
    `${V2}/stops/${stopId}/events`,
    token,
    body,
    { 'Idempotency-Key': idemKey || uuid() },
    { name: 'stop_event' }
  );
}

export function openRoute(base, token, routeId) {
  return rid(base, `${V2}/routes/${routeId}`, token, {}, { name: 'open_route' });
}

export function home(base, token) {
  return rid(base, `${V2}/rider/home`, token, {}, { name: 'home' });
}

/** POST /api/v2/routes/{id}/optimize -> job; poll GET /api/v2/jobs/{id}. */
export function optimize(base, token, routeId, pollSeconds) {
  const start = post(base, `${V2}/routes/${routeId}/optimize`, token, {}, null, { name: 'optimize_request' });
  if (start.status !== 200 && start.status !== 202) {
    return { ok: false, status: start.status, body: start.body };
  }
  const jobId = start.data && start.data.id;
  if (!jobId) return { ok: false, status: start.status, body: start.body };
  const deadline = Date.now() + (pollSeconds || 30) * 1000;
  while (Date.now() < deadline) {
    const job = rid(base, `${V2}/jobs/${jobId}`, token, {}, { name: 'optimize_poll' });
    if (job.data && (job.data.status === 'done' || job.data.status === 'failed')) {
      return { ok: job.data.status === 'done', status: job.status, job: job.data };
    }
    sleep(0.25);
  }
  return { ok: false, status: 0, body: { error: 'optimize job timed out' } };
}

export function login(base, email, password) {
  const r = post(base, `${V1}/auth/login`, null, { email, password, client: 'mobile' }, null, {
    name: 'login',
  });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data;
}

export function register(base, email, password, fullName) {
  return post(
    base,
    `${V1}/auth/register`,
    null,
    { fullName: fullName || 'Load Test Rider', email, password, confirmPassword: password },
    null,
    { name: 'register' }
  );
}
