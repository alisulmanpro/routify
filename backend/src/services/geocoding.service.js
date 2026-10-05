import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { GeocodeCache } from '../models/geocode-cache.js';
import { normalizeAddress } from '../utils/geo.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = () => AbortSignal.timeout(8000);
const NOMINATIM_INTERVAL = 1100;
let lastNominatimRequest = 0;

const GENERIC_LOCALITIES = new Set(['house', 'street', 'road', 'avenue', 'lane', 'block', 'sector', 'flat', 'apartment', 'hospital', 'near', 'opposite']);
const BROAD_PLACES = new Set(['pakistan', 'india', 'bangladesh', 'nepal', 'sri lanka', 'united states', 'usa', 'united kingdom', 'uk', 'punjab', 'sindh', 'balochistan', 'khyber pakhtunkhwa']);
const BROAD_ADDRESS_TYPES = new Set(['country', 'state', 'province', 'region', 'county', 'city', 'town', 'village', 'municipality', 'district', 'suburb', 'neighbourhood', 'hamlet', 'postcode', 'borough', 'quarter']);

const expandAddressAbbreviations = (raw) => String(raw || '')
  .replace(/\bDHQ\b/gi, 'District Headquarters')
  .replace(/\bTHQ\b/gi, 'Tehsil Headquarters')
  .trim();
export function localityQueries(raw) {
  const address = String(raw || '').trim();
  let chunks = address.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  const candidates = [];
  if (chunks.length > 1) {
    while (chunks.length && BROAD_PLACES.has(chunks.at(-1).toLowerCase())) chunks = chunks.slice(0, -1);
    for (let start = chunks.length - 1; start >= 0; start -= 1) candidates.push(chunks.slice(start).join(', '));
  } else {
    const words = address.split(/\s+/).filter(Boolean);
    while (words.length && BROAD_PLACES.has(words.slice(-2).join(' ').toLowerCase())) words.splice(-2);
    while (words.length && BROAD_PLACES.has(words.at(-1).toLowerCase())) words.pop();
    for (let count = Math.min(3, words.length); count >= 1; count -= 1) {
      const candidate = words.slice(-count).join(' ');
      if (!/^\d+$/.test(candidate) && !GENERIC_LOCALITIES.has(candidate.toLowerCase())) candidates.push(candidate);
    }
  }
  const original = normalizeAddress(address);
  return [...new Set(candidates)].filter((candidate) => normalizeAddress(candidate) !== original);
}

async function searchNominatim(query) {
  const wait = Math.max(0, lastNominatimRequest + NOMINATIM_INTERVAL - Date.now());
  if (wait) await sleep(wait);
  lastNominatimRequest = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1', q: query }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': env.GEOCODING_USER_AGENT || 'delivery-planner (dev)', Accept: 'application/json' }, signal: timeout() });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const [hit] = await res.json();
  return hit ? { latitude: Number(hit.lat), longitude: Number(hit.lon), normalized: hit.display_name, broad: BROAD_ADDRESS_TYPES.has(String(hit.addresstype || '').toLowerCase()) } : null;
}

const providers = {
  async none() {
    return null;
  },
  // OSM's public instance allows max 1 request/second and requires an identifying User-Agent.
  async nominatim(address) {
    const exact = await searchNominatim(address);
    if (exact && !exact.broad) return { ...exact, approximate: false };

    // Expand common hospital abbreviations and add country context before locality fallbacks.
    let approximate = exact;
    const country = env.GEOCODING_COUNTRY.trim();
    const expanded = expandAddressAbbreviations(address);
    const fullQueries = expanded === address ? [] : [expanded];
    for (const query of fullQueries) {
      const qualified = await searchNominatim(country && !query.toLowerCase().endsWith(country.toLowerCase()) ? `${query}, ${country}` : query);
      if (qualified && !qualified.broad) return { ...qualified, approximate: false };
      if (qualified) approximate ||= qualified;
    }
    if (country && !address.toLowerCase().endsWith(country.toLowerCase())) {
      const qualified = await searchNominatim(`${address}, ${country}`);
      if (qualified && !qualified.broad) return { ...qualified, approximate: false };
      if (qualified) approximate ||= qualified;
    }
    for (const locality of localityQueries(address)) {
      const fallback = await searchNominatim(locality);
      if (fallback && !fallback.broad) return { ...fallback, approximate: true };
      if (fallback) approximate ||= fallback;
    }
    return approximate ? { ...approximate, approximate: true } : null;
  },
  async google(address) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${env.GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url, { signal: timeout() });
    if (!res.ok) throw new Error(`Google Geocoding responded ${res.status}`);
    const json = await res.json();
    if (json.status === 'ZERO_RESULTS') return null;
    if (json.status !== 'OK') throw new Error(`Google Geocoding status ${json.status}`);
    const hit = json.results[0];
    return { latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng, normalized: hit.formatted_address };
  },
};

let lookup = providers[env.GEOCODING_PROVIDER];
export const setGeocoderForTests = (fn) => { lookup = fn || providers[env.GEOCODING_PROVIDER]; };

const cacheKey = (raw) => crypto.createHash('sha1').update(normalizeAddress(raw)).digest('hex');

/** Returns { latitude, longitude, normalized } or null. Provider errors are treated as "not found this time" and are not cached. */
export async function geocodeAddress(raw, { retryApproximate = false } = {}) {
  const key = cacheKey(raw);
  const cached = await GeocodeCache.findOne({ key }).lean();
  if (cached?.found && (!retryApproximate || !cached.approximate)) {
    return { latitude: cached.latitude, longitude: cached.longitude, normalized: cached.normalized, approximate: !!cached.approximate };
  }

  let result = null;
  try {
    result = await lookup(raw);
  } catch (error) {
    logger.warn({ err: error }, 'Geocoding provider failed');
    throw new AppError(503, 'GEOCODING_UNAVAILABLE', 'Address lookup is temporarily unavailable. Check your connection and try planning the route again.');
  }
  if (result) {
    await GeocodeCache.updateOne(
      { key },
      { key, found: true, ...result, provider: env.GEOCODING_PROVIDER, expiresAt: new Date(Date.now() + (result.approximate ? 7 : 180) * DAY) },
      { upsert: true },
    ).catch(() => {});
  }
  return result;
}

/** Geocodes distinct addresses respecting provider limits. Returns Map(raw → result|null). */
export async function geocodeMany(addresses, options) {
  const unique = [...new Set(addresses)];
  const out = new Map();
  const one = async (raw) => {
    out.set(raw, await geocodeAddress(raw, options));
  };

  if (env.GEOCODING_PROVIDER === 'nominatim') for (const raw of unique) await one(raw);
  else {
    const queue = [...unique];
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
  }
  return out;
}
