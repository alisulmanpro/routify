/**
 * P8.6 — optimise a 200-stop route in < 5 s without blocking the API.
 *
 * Half of the VUs trigger `POST /api/v2/routes/{id}/optimize` and poll the job; the
 * other half only read (Home, route). The reads are the ones that must stay fast:
 * the optimisation must not block the API.
 */
import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { assertStaging } from '../lib/staging.js';
import { loadRiders, riderFor, withAuth } from '../lib/riders.js';
import { home, openRoute, optimize } from '../lib/api.js';
import { baseThresholds } from '../lib/targets.js';

const riders = loadRiders();
const optimiseSeconds = new Trend('optimise_seconds', true);

export const options = {
  scenarios: {
    optimize: {
      executor: 'ramping-vus',
      startVUs: Number(__ENV.VUS || 10),
      stages: [
        { duration: __ENV.RAMP || '20s', target: Number(__ENV.VUS || 10) },
        { duration: __ENV.STEADY || '3m', target: Number(__ENV.VUS || 10) },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ...baseThresholds({ routeOpen: true, events: false }),
    'http_req_duration{name:optimize_poll}': ['p(95)<1000'],
  },
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

  if (exec.vu.idInTest % 2 === 0) {
    const res = withAuth(data.base, rider, (t) => home(data.base, t));
    check(res, { 'home 200': (r) => r.status === 200 });
  } else {
    const started = Date.now();
    const res = withAuth(data.base, rider, (t) => optimize(data.base, t, rider.routeId, Number(__ENV.JOB_TIMEOUT || 60)));
    const seconds = (Date.now() - started) / 1000;
    check(res, { 'optimise finished': (r) => r.ok === true });
    optimiseSeconds.add(seconds);
    console.log(`optimise seconds=${seconds.toFixed(2)} ok=${res.ok === true}`);
  }

  sleep(Number(__ENV.SLEEP || '2'));
}
