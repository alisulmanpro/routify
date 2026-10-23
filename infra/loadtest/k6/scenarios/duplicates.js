/**
 * P8.1 scenario 3 — duplicates.
 *
 * Two ways a stop can be created twice:
 *  1. the phone resends the same batch (same clientIds) after a dropped answer;
 *  2. the phone sends a stop event twice with the same Idempotency-Key.
 *
 * The server must not create a second row and must not apply the event twice.
 */
import { sleep } from 'k6';
import { assertStaging } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { openRoute, post, stopEvent, uuid, makeStop, V2 } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();

export const options = {
  scenarios: {
    duplicates: {
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

export default function (data) {
  const rider = riderFor(riders, exec.vu.idInTest);

  // 1. the same batch sent twice
  const items = [];
  for (let i = 0; i < Number(__ENV.BATCH || 10); i++) items.push(makeStop(i + 1000, 'DUP'));
  const first = withAuth(data.base, rider, (t) => post(data.base, `${V2}/deliveries/batch`, t, { items }, null, { name: 'create_stops' }));
  check(first, { 'batch 201/200': (r) => r.status === 200 || r.status === 201 });

  const second = withAuth(data.base, rider, (t) => post(data.base, `${V2}/deliveries/batch`, t, { items }, null, { name: 'create_stops' }));
  check(second, {
    'resend answers 200': (r) => r.status === 200,
    'resend creates nothing': (r) => r.data && r.data.created === 0,
    'resend finds the same stops': (r) => r.data && r.data.existing === items.length,
  });

  // 2. the same stop event sent twice
  const routeRes = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
  const stops = (routeRes.data && routeRes.data.stops) || [];
  const next = stops.find((s) => s.status === 'pending' || s.status === 'in_progress');
  if (next) {
    const key = uuid();
    const e1 = withAuth(data.base, rider, (t) => stopEvent(data.base, t, next.id, 'deliver', key, { allowSkip: true }));
    const e2 = withAuth(data.base, rider, (t) => stopEvent(data.base, t, next.id, 'deliver', key, { allowSkip: true }));
    check(e1, { 'event 200': (r) => r.status === 200 });
    check(e2, { 'replayed event 200': (r) => r.status === 200 });
  }

  sleep(Number(__ENV.SLEEP || '1'));
}
