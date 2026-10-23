/**
 * The Phase 8 targets, in one place. task.md P8.3-P8.8.
 *
 *   P8.3  simple read            p95 < 150 ms
 *   P8.4  stop event             p95 < 250 ms
 *   P8.5  route open (200 stops) < 800 ms on 4G, < 150 KB gzipped
 *   P8.6  optimise 200 stops     < 5 s, never blocks the API
 *   P8.7  Home = 1 request, deliver = 1 request, Home first paint < 300 ms
 *   P8.8  zero duplicates, zero lost events, error rate < 0.1 %
 */
export const TARGETS = {
  readP95Ms: 150,
  stopEventP95Ms: 250,
  routeOpenMs: 800,
  routeOpenGzippedKb: 150,
  optimiseSeconds: 5,
  errorRate: 0.001,
};

/** k6 thresholds for a scenario that does reads and stop events. */
export function baseThresholds(opts) {
  const o = opts || {};
  const t = {
    'http_req_failed': [`rate<${TARGETS.errorRate}`],
    checks: ['rate>0.99'],
  };
  if (o.reads !== false) {
    t[`http_req_duration{name:${o.readTag || 'home'}}`] = [`p(95)<${TARGETS.readP95Ms}`];
  }
  if (o.events !== false) {
    t[`http_req_duration{name:stop_event}`] = [`p(95)<${TARGETS.stopEventP95Ms}`];
  }
  if (o.routeOpen) {
    t['http_req_duration{name:open_route}'] = [`p(95)<${TARGETS.routeOpenMs}`];
  }
  return t;
}
