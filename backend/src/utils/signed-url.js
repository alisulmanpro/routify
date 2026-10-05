import crypto from 'node:crypto';
import { env } from '../config/env.js';

const mac = (key, exp, disposition) => crypto.createHmac('sha256', env.FILE_SIGNING_SECRET).update(`${key}.${exp}.${disposition}`).digest('base64url');

/** Returns an API-relative URL; clients resolve it against their API origin. */
export function signFileUrl(key, { download = false, ttl = env.SIGNED_URL_TTL_SECONDS } = {}) {
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const disposition = download ? 'attachment' : 'inline';
  const sig = mac(key, exp, disposition);
  return `/api/v1/files/${key}?exp=${exp}&d=${disposition}&sig=${sig}`;
}

export function verifyFileSignature(key, exp, disposition, sig) {
  if (!key || !exp || !sig || !['inline', 'attachment'].includes(disposition)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(mac(key, exp, disposition));
  const actual = Buffer.from(String(sig));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
