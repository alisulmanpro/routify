/**
 * Riders for the load test.
 *
 * The riders are created once, before the run, by `scripts/seed_riders.py` (it also
 * writes the token file). The file is a JSON array:
 *   [ { "email": "...", "password": "...", "accessToken": "...", "refreshToken": "..." } ]
 *
 * Every VU takes one rider; with `per-vu` scenarios the same rider may be used by two
 * VUs at once on purpose (the "two devices" scenario).
 */
import { login } from './api.js';

export function loadRiders() {
  const inline = __ENV.RIDERS_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (e) {
      throw new Error(`RIDERS_JSON is not valid JSON: ${e}`);
    }
  }
  const path = __ENV.RIDER_FILE || 'infra/loadtest/data/riders.json';
  let raw;
  try {
    raw = open(path);
  } catch (e) {
    throw new Error(
      `Rider file "${path}" not found. Create it first:\n` +
      '  python3 infra/loadtest/scripts/seed_riders.py --riders 1000 --out infra/loadtest/data/riders.json\n' +
      'Nothing was sent to the server.'
    );
  }
  let riders;
  try {
    riders = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Rider file "${path}" is not valid JSON: ${e}`);
  }
  if (!Array.isArray(riders) || riders.length === 0) {
    throw new Error(`Rider file "${path}" is empty.`);
  }
  return riders;
}

export function riderFor(riders, index) {
  return riders[index % riders.length];
}

/** Refresh the access token (they last 15 minutes) and write it back into the rider object. */
export function refreshRider(base, rider) {
  const res = login(base, rider.email, rider.password);
  rider.accessToken = res.accessToken;
  if (res.refreshToken) rider.refreshToken = res.refreshToken;
  return rider;
}

/**
 * Run a request with the rider's token; on 401 (token older than 15 minutes) refresh
 * once and run it again.
 */
export function withAuth(base, rider, fn) {
  let res = fn(rider.accessToken);
  if (res.status === 401) {
    refreshRider(base, rider);
    res = fn(rider.accessToken);
  }
  return res;
}
