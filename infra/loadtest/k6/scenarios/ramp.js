/**
 * P8.2 — ramp 1K -> 5K -> 10K concurrent riders on staging.
 *
 * Every VU is a rider (an account from the rider file). The mix is what the app
 * really does: mostly reads (Home, route), a few stop events.
 *
 * The stages default to 2 minutes each; shorten them for a smoke run:
 *   k6 run -e RAMP_STAGES=10s,20s,30s ...
 */
import { sleep } from 'k6';
import { assertStaging } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { home, openRoute, stopEvent, uuid } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();

function stages() {
  const raw = __ENV.RAMP_STAGES || '2m,2m,2m';
  const targets = [Number(__ENV.VUS_1K || 1000), Number(__ENV.VUS_5K || 5000), Number(__ENV.VUS_10K || 10000)];
  return raw.split(',').map((d, i) => ({ duration: d.trim(), target: targets[i] || targets[targets.length - 1] }));
}

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: '60s',
    },
  },
  thresholds: {
    ...baseThresholds({ routeOpen: true }),
    'http_req_duration{name:open_route}': ['p(95)<800'],
  },
  discardResponseBodies: false,
  noConnectionReuse: false,
};

export function setup() {
  const target = assertStaging(__ENV.BASE_URL);
  return { base: target.url, local: target.local };
}

export default function (data) {
  const rider = riderFor(riders, exec.vu.idInTest);
  const roll = Math.random();

  if (roll < 0.7) {
    const res = withAuth(data.base, rider, (t) => home(data.base, t));
    check(res, { 'home 200': (r) => r.status === 200 });
  } else if (roll < 0.9 && rider.routeId) {
    const res = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
    check(res, { 'route open 200': (r) => r.status === 200 });
  } else if (rider.routeId) {
    const routeRes = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
    const stops = (routeRes.data && routeRes.data.stops) || [];
    const next = stops.find((s) => s.status === 'pending' || s.status === 'in_progress');
    if (next) {
      const res = withAuth(data.base, rider, (t) =>
        stopEvent(data.base, t, next.id, 'deliver', uuid(), { allowSkip: true })
      );
      check(res, { 'stop event 200': (r) => r.status === 200 });
    }
  }

  sleep(Number(__ENV.SLEEP || '1'));
}
