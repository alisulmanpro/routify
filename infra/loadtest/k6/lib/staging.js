/**
 * Staging-only guard.
 *
 * Load tests must never touch production. Every k6 scenario calls `assertStaging()`
 * in its `setup()`; the script exits before sending a single request when the target
 * is not clearly a staging environment.
 *
 * Rules:
 *  1. BASE_URL must be set (there is no default).
 *  2. The hostname must match STAGING_HOST_PATTERN (default: /staging/i).
 *  3. The hostname must not match a production hostname (PROD_HOSTS, default: the
 *     known production hosts of this project).
 *  4. localhost / 127.0.0.1 is refused unless ALLOW_LOCAL=1. A local rehearsal may
 *     never be reported as a staging result (the report prints "local (not staging)").
 */

const DEFAULT_PROD_HOSTS = [
  'routify-api.onrender.com',
  'api.routify.ie',
  'www.routify.ie',
  'routify.ie',
];

export function assertStaging(baseUrl) {
  const raw = baseUrl || __ENV.BASE_URL || '';
  if (!raw) {
    throw new Error(
      'BASE_URL is not set. Load tests may only run against a staging environment.\n' +
      'Set BASE_URL to your staging API (for example https://routify-api-staging.onrender.com).\n' +
      'Nothing was sent.'
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new Error(`BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`BASE_URL must be http(s): ${raw}`);
  }

  const host = url.hostname.toLowerCase();
  const pattern = new RegExp(__ENV.STAGING_HOST_PATTERN || 'staging', 'i');
  const prodHosts = (__ENV.PROD_HOSTS || DEFAULT_PROD_HOSTS.join(','))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) {
    if (__ENV.ALLOW_LOCAL !== '1') {
      throw new Error(
        `Refusing to load test ${host}. Set ALLOW_LOCAL=1 for a local rehearsal ` +
        '(its numbers are not staging numbers and must not be used for the Phase 8 targets).'
      );
    }
    return { url: raw.replace(/\/$/, ''), host, local: true };
  }

  if (prodHosts.some((p) => host === p || host.endsWith('.' + p))) {
    throw new Error(`Refusing to load test production host "${host}". Staging only.`);
  }
  if (!pattern.test(host)) {
    throw new Error(
      `Refusing to load test "${host}": the hostname does not look like a staging host ` +
      `(pattern "${__ENV.STAGING_HOST_PATTERN || 'staging'}"). Staging only.`
    );
  }
  return { url: raw.replace(/\/$/, ''), host, local: false };
}

export function apiUrl(base, path) {
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}
