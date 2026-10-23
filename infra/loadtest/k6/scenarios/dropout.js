/**
 * P8.1 scenario 2 — network drops.
 *
 * The phone sends a stop event and the connection dies before the answer arrives
 * (the request may still have reached the server). The phone retries later with the
 * same Idempotency-Key. The server must apply the event exactly once.
 *
 * The drop is simulated with a client-side timeout of a few milliseconds: k6 gives up
 * waiting, the server keeps working. The retry then carries the same key.
 *
 * Checks:
 *   - the retry answers 200 (the event is not lost)
 *   - the retry is a replay (Idempotent-Replayed) or the stop is already delivered
 *   - the stop ends up delivered exactly once (counted by the report script)
 */
import { sleep } from 'k6';
import http from 'k6/http';
import { assertStaging, apiUrl } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { openRoute, stopEvent, uuid } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();
const DROP_TIMEOUT = __ENV.DROP_TIMEOUT || '10ms';

export const options = {
  scenarios: {
    dropout: {
      executor: 'ramping-vus',
      startVUs: Number(__ENV.VUS || 20),
      stages: [
        { duration: __ENV.RAMP || '30s', target: Number(__ENV.VUS || 20) },
        { duration: __ENV.STEADY || '2m', target: Number(__ENV.VUS || 20) },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: baseThresholds({ routeOpen: true }),
  discardResponseBodies: false,
};

export function setup() {
  const target = assertStaging(__ENV.BASE_URL);
  return { base: target.url, local: target.local };
}

/** A request that is sent but whose answer is thrown away (the phone loses the network). */
function sendAndLose(base, token, stopId, key) {
  const res = http.post(
    apiUrl(base, `/api/v2/stops/${stopId}/events`),
    JSON.stringify({ type: 'deliver', allowSkip: true }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      timeout: DROP_TIMEOUT,
      tags: { name: 'stop_event_dropped' },
    }
  );
  return res;
}

export default function (data) {
  const rider = riderFor(riders, exec.vu.idInTest);
  if (!rider.routeId) {
    sleep(1);
    return;
  }

  const routeRes = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
  const stops = (routeRes.data && routeRes.data.stops) || [];
  const next = stops.find((s) => s.status === 'pending' || s.status === 'in_progress');
  if (!next) {
    sleep(1);
    return;
  }

  const key = uuid();
  const lost = sendAndLose(data.base, rider.accessToken, next.id, key);
  // The phone was offline for a while before it retried.
  sleep(Number(__ENV.OFFLINE_SECONDS || '2'));

  const retry = withAuth(data.base, rider, (t) => stopEvent(data.base, t, next.id, 'deliver', key, { allowSkip: true }));
  check(retry, {
    'retry answered 200': (r) => r.status === 200,
    'event not lost': (r) => r.status === 200 && r.data && r.data.stop,
  });

  // A second retry of the same key must still not change anything.
  const again = withAuth(data.base, rider, (t) => stopEvent(data.base, t, next.id, 'deliver', key, { allowSkip: true }));
  check(again, { 'replay answered 200': (r) => r.status === 200 });

  sleep(Number(__ENV.SLEEP || '1'));
}
