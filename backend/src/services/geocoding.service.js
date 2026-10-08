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

/** Riders deliver across a metro area, so a service area is a fixed radius around its centre. */
export const SERVICE_AREA_RADIUS_KM = 35;

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

/** [minLon, minLat, maxLon, maxLat] covering SERVICE_AREA_RADIUS_KM around the area centre. */
export function areaBox(area) {
  const dLat = SERVICE_AREA_RADIUS_KM / 111;
  const dLon = SERVICE_AREA_RADIUS_KM / (111 * Math.max(0.2, Math.cos(area.latitude * Math.PI / 180)));
  return [area.longitude - dLon, area.latitude - dLat, area.longitude + dLon, area.latitude + dLat];
}

export function isInsideArea(point, area) {
  if (!area || point?.latitude == null || point?.longitude == null) return true;
  const [minLon, minLat, maxLon, maxLat] = areaBox(area);
  return point.longitude >= minLon && point.longitude <= maxLon && point.latitude >= minLat && point.latitude <= maxLat;
}

async function nominatim(path, params) {
  const wait = Math.max(0, lastNominatimRequest + NOMINATIM_INTERVAL - Date.now());
  if (wait) await sleep(wait);
  lastNominatimRequest = Date.now();

  const url = new URL(`https://nominatim.openstreetmap.org/${path}`);
  url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'en', ...params }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': env.GEOCODING_USER_AGENT || 'delivery-planner (dev)', Accept: 'application/json' }, signal: timeout() });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  return res.json();
}

/** Searches near the rider's service area. `bounded` keeps results inside it; otherwise it only restricts the country. */
async function searchNominatim(query, area, { bounded }) {
  const params = { limit: '1', q: query };
  if (area) {
    params.countrycodes = area.countryCode;
    if (bounded) Object.assign(params, { viewbox: areaBox(area).join(','), bounded: '1' });
  }
  const [hit] = await nominatim('search', params);
  return hit ? { latitude: Number(hit.lat), longitude: Number(hit.lon), normalized: hit.display_name, broad: BROAD_ADDRESS_TYPES.has(String(hit.addresstype || '').toLowerCase()) } : null;
}

const providers = {
  async none() {
    return null;
  },
  // OSM's public instance allows max 1 request/second and requires an identifying User-Agent.
  async nominatim(address, area) {
    const queries = [...new Set([address, expandAddressAbbreviations(address)])];
    let approximate = null;

    // 1. The full address inside the rider's city.
    for (const query of queries) {
      const hit = await searchNominatim(query, area, { bounded: true });
      if (hit && !hit.broad) return { ...hit, approximate: false };
      approximate ||= hit;
    }
    if (!area) return approximate ? { ...approximate, approximate: true } : null;

    // 2. The full address anywhere in the rider's country, for stops that name another town.
    //    A match outside the service area is flagged so the rider double-checks it.
    const wider = await searchNominatim(address, area, { bounded: false });
    if (wider && !wider.broad) return { ...wider, approximate: !isInsideArea(wider, area) };

    // 3. Fragments ("passport office", "main bazar") only ever match inside the city. Searched
    //    worldwide they land on other continents.
    for (const locality of localityQueries(address)) {
      const hit = await searchNominatim(locality, area, { bounded: true });
      if (hit && !hit.broad) return { ...hit, approximate: true };
      approximate ||= hit;
    }
    return approximate ? { ...approximate, approximate: true } : null;
  },
  async google(address, area) {
    const params = new URLSearchParams({ address, key: env.GOOGLE_MAPS_API_KEY });
    if (area) {
      const [minLon, minLat, maxLon, maxLat] = areaBox(area);
      params.set('bounds', `${minLat},${minLon}|${maxLat},${maxLon}`);
      params.set('components', `country:${area.countryCode}`);
    }
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: timeout() });
    if (!res.ok) throw new Error(`Google Geocoding responded ${res.status}`);
    const json = await res.json();
    if (json.status === 'ZERO_RESULTS') return null;
    if (json.status !== 'OK') throw new Error(`Google Geocoding status ${json.status}`);
    const hit = json.results[0];
    const result = { latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng, normalized: hit.formatted_address };
    return { ...result, approximate: hit.geometry.location_type === 'APPROXIMATE' || !isInsideArea(result, area) };
  },
};

let lookup = providers[env.GEOCODING_PROVIDER];
export const setGeocoderForTests = (fn) => { lookup = fn || providers[env.GEOCODING_PROVIDER]; };

// The same text means different places in different cities, so the rider's area is part of the key.
const areaKey = (area) => (area ? `${area.countryCode}:${area.latitude.toFixed(2)},${area.longitude.toFixed(2)}` : 'anywhere');
const cacheKey = (raw, area) => crypto.createHash('sha1').update(`v2|${areaKey(area)}|${normalizeAddress(raw)}`).digest('hex');

/** Returns { latitude, longitude, normalized, approximate } or null. Provider errors are treated as "not found this time" and are not cached. */
export async function geocodeAddress(raw, { retryApproximate = false, area = null } = {}) {
  const key = cacheKey(raw, area);
  const cached = await GeocodeCache.findOne({ key }).lean();
  if (cached?.found && (!retryApproximate || !cached.approximate)) {
    return { latitude: cached.latitude, longitude: cached.longitude, normalized: cached.normalized, approximate: !!cached.approximate };
  }

  let result = null;
  try {
    result = await lookup(raw, area);
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

// ---- Rider service area (the city a rider delivers in) ----

const stripSuffix = (name) => String(name || '').replace(/^(Greater|City of)\s+/i, '').replace(/\s+(District|County|Tehsil|Division|Municipality)$/i, '').trim();

/** Picks a human city name; OSM nests cities differently per country (London is "Greater London", Lahore a "District"). */
function cityName(wide, local) {
  const a = wide?.address || {};
  const b = local?.address || {};
  return stripSuffix(a.city || b.city || b.town || a.county || b.county || a.district || b.district || b.village || b.municipality || local?.name || wide?.name);
}

const resolveAreaFromNominatim = async ({ latitude, longitude }) => {
  if (env.GEOCODING_PROVIDER === 'none') return null;
  const point = { lat: String(latitude), lon: String(longitude) };
  const local = await nominatim('reverse', { ...point, zoom: '10' });
  if (!local?.address?.country_code) return null;
  const wide = await nominatim('reverse', { ...point, zoom: '8' });
  return { city: cityName(wide, local), country: local.address.country, countryCode: local.address.country_code.toLowerCase(), latitude, longitude };
};
let areaResolver = resolveAreaFromNominatim;
export const setAreaResolverForTests = (fn) => { areaResolver = fn || resolveAreaFromNominatim; };

/** Detects the rider's city from a GPS point. Results are reused for nearby points for an hour. */
const areaMemo = new Map();
export async function detectServiceArea({ latitude, longitude }) {
  const memoKey = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  const memo = areaMemo.get(memoKey);
  if (memo && memo.expires > Date.now()) return memo.area;
  let area;
  try {
    area = await areaResolver({ latitude, longitude });
  } catch (error) {
    logger.warn({ err: error }, 'Service area lookup failed');
    throw new AppError(503, 'GEOCODING_UNAVAILABLE', 'Could not detect your city right now. Check your connection and try again.');
  }
  if (area) {
    if (areaMemo.size > 500) areaMemo.clear();
    areaMemo.set(memoKey, { area, expires: Date.now() + 3_600_000 });
  }
  return area;
}

/** Finds a city typed by the rider, e.g. "London" or "Narowal, Pakistan". */
export async function findServiceArea(query) {
  if (env.GEOCODING_PROVIDER === 'none') return null;
  let hit;
  try {
    [hit] = await nominatim('search', { q: query, limit: '1', featureType: 'settlement' });
  } catch (error) {
    logger.warn({ err: error }, 'Service area search failed');
    throw new AppError(503, 'GEOCODING_UNAVAILABLE', 'Could not look up that city right now. Check your connection and try again.');
  }
  if (!hit?.address?.country_code) return null;
  return {
    city: stripSuffix(hit.name || hit.address.city || hit.address.town),
    country: hit.address.country,
    countryCode: hit.address.country_code.toLowerCase(),
    latitude: Number(hit.lat),
    longitude: Number(hit.lon),
  };
}
