import { post } from './api';
import { findDuplicate, type Duplicate } from './duplicates';
import { findEircode } from './format';
import type { Delivery, GeocodeCheck } from './types';
import { submitStops } from './outbox';

type Point = { latitude: number; longitude: number };

/** Looks an address up on the map (Ireland, biased to `near` or the rider's service area) without saving anything. */
export async function checkAddress(address: string, near: Point | null): Promise<GeocodeCheck> {
  return (await post<GeocodeCheck>('/deliveries/geocode-check', { address, ...(near || {}) })).data;
}

/** Thrown by createStop instead of saving a stop that is already on the list. */
export class DuplicateStopError extends Error {
  constructor(readonly duplicate: Duplicate<Delivery>) {
    super(`Already in your stops (#${duplicate.index + 1})${duplicate.eircode ? `: ${duplicate.eircode}` : ''}`);
    this.name = 'DuplicateStopError';
  }
}

/**
 * Saves one stop for a day: the one way every entry path adds a stop. `normalized` is the address the map found for
 * what was typed (e.g. the street of a place name or an Eircode); `location` is the point to use, or null to let the
 * server look it up; `precise` says the point is the door, not an area. A stop that duplicates one in `existing`
 * (same Eircode, or within 15 m) is not saved unless `allowDuplicate` (two parcels for one house).
 */
export async function createStop({ raw, parcel, date, location, normalized, precise = true, existing, allowDuplicate = false }: {
  raw: string; parcel: string; date: string; location: Point | null; normalized?: string | null; precise?: boolean;
  existing: readonly Delivery[]; allowDuplicate?: boolean;
}): Promise<Delivery> {
  if (!allowDuplicate) {
    const duplicate = findDuplicate({ eircode: findEircode(raw) || findEircode(normalized), point: precise ? location : null }, existing);
    if (duplicate) throw new DuplicateStopError(duplicate);
  }
  // Through the outbox (P4.1): saved at once when online; offline it is kept on the phone (a stand-in flagged
  // pending_sync is returned) and sent later. The phone's own id means a retry never adds it twice. "Add anyway" on a
  // same-Eircode stop is a second parcel (P4.7).
  const [saved] = await submitStops([{
    trackingId: parcel.trim().toUpperCase(),
    address: { raw, ...(normalized && normalized !== raw ? { normalized: normalized.slice(0, 400) } : {}) },
    serviceDate: date,
    ...(location ? { location } : {}),
    ...(allowDuplicate ? { secondParcel: true } : {}),
  }]);
  return saved;
}
