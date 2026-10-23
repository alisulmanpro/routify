/**
 * P8.1 scenario 1 — a rider with a prepared 200-stop route.
 *
 * One VU = one rider. Every iteration: open Home (1 request), open the route
 * (1 request), then deliver the next stop of the route (1 request) the way the app
 * does it: POST /api/v2/stops/{id}/events.
 *
 * The route is prepared before the run by scripts/seed_riders.py (--stops 200).
 */
import { sleep } from 'k6';
import { assertStaging } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { home, openRoute, stopEvent, uuid } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();

export const options = {
  scenarios: {
    route200: {
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
  if (!rider.routeId) {
    sleep(1);
    return;
  }

  const homeRes = withAuth(data.base, rider, (t) => home(data.base, t));
  check(homeRes, { 'home 200': (r) => r.status === 200 });

  const routeRes = withAuth(data.base, rider, (t) => openRoute(data.base, t, rider.routeId));
  check(routeRes, { 'route open 200': (r) => r.status === 200 });

  const stops = (routeRes.data && routeRes.data.stops) || [];
  const next = stops.find((s) => s.status === 'pending' || s.status === 'in_progress');
  if (next) {
    const key = uuid();
    const eventRes = withAuth(data.base, rider, (t) =>
      stopEvent(data.base, t, next.id, 'deliver', key, { allowSkip: true })
    );
    check(eventRes, { 'stop event 200': (r) => r.status === 200 });
  }

  sleep(Number(__ENV.SLEEP || '1'));
}
