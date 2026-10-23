/**
 * P8.1 scenario 4 — two devices on one account.
 *
 * Two VUs share the same rider (the phone and the tablet of the same rider). They
 * open the same route and try to deliver the same stop at the same time.
 *
 * Expected: the stop is delivered once, one device gets 200, the other gets the
 * "already delivered" answer (409 INVALID_STATE) or the same result. No double
 * delivery, no lost event, no duplicated route.
 */
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { assertStaging } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { openRoute, stopEvent, uuid } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();
const DEVICES = Number(__ENV.DEVICES || 2);

const deliveredOk = new Counter('two_devices_delivered_ok');
const alreadyDone = new Counter('two_devices_already_done');
const conflicts = new Counter('two_devices_conflicts');

export const options = {
  scenarios: {
    two_devices: {
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
  // Consecutive VU pairs share one rider.
  const rider = riderFor(riders, Math.floor(exec.vu.idInTest / DEVICES));
  if (!rider.routeId) {
    sleep(1);
    return;
  }

  const routeRes = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
  check(routeRes, { 'route open 200': (r) => r.status === 200 });

  const stops = (routeRes.data && routeRes.data.stops) || [];
  const next = stops.find((s) => s.status === 'pending' || s.status === 'in_progress');
  if (!next) {
    sleep(1);
    return;
  }

  const res = withAuth(data.base, rider, (t) =>
    stopEvent(data.base, t, next.id, 'deliver', uuid(), { allowSkip: true })
  );

  if (res.status === 200) {
    deliveredOk.add(1);
  } else if (res.status === 409) {
    alreadyDone.add(1);
    const code = res.error && res.error.code;
    if (code && code !== 'INVALID_STATE' && code !== 'EARLIER_STOPS_REMAIN') conflicts.add(1);
  } else {
    conflicts.add(1);
  }

  sleep(Number(__ENV.SLEEP || '1'));
}
