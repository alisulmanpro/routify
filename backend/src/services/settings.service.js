import { Setting } from '../models/setting.js';

export const DEFAULT_SETTINGS = {
  currencies: ['USD', 'GBP', 'EUR', 'PKR', 'INR'],
  defaultCurrency: 'USD',
  trialDays: 14,
  route: { defaultPreference: 'smart', avgSpeedKmh: 25, stopServiceMinutes: 3 },
  reports: { includePhotos: true },
  platform: { name: 'Routify', supportEmail: '', privacyUrl: '', paymentInstructions: '' },
  security: { minPasswordLength: 8, maxFailedLogins: 5, lockoutMinutes: 15 },
};

let cache = null;
let cachedAt = 0;
const TTL_MS = 15_000;

const merge = (base, patch) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
};

export async function getSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const doc = await Setting.findOne({ key: 'platform' }).lean();
  cache = merge(DEFAULT_SETTINGS, doc?.value);
  cachedAt = Date.now();
  return cache;
}

export async function updateSettings(patch) {
  const next = merge(await getSettings(), patch);
  if (!next.currencies.includes(next.defaultCurrency)) next.defaultCurrency = next.currencies[0];
  await Setting.findOneAndUpdate({ key: 'platform' }, { value: next }, { upsert: true });
  cache = next;
  cachedAt = Date.now();
  return next;
}

/** What the mobile app may know before login. */
export async function getPublicConfig() {
  const s = await getSettings();
  return {
    currencies: s.currencies,
    defaultCurrency: s.defaultCurrency,
    routePreference: s.route.defaultPreference,
    minPasswordLength: s.security.minPasswordLength,
    platformName: s.platform.name,
    supportEmail: s.platform.supportEmail,
    privacyUrl: s.platform.privacyUrl,
    paymentInstructions: s.platform.paymentInstructions,
  };
}

export const resetSettingsCache = () => { cache = null; };
