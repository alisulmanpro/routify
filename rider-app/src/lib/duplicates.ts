// One rule for "this stop is already on the list", used by every way of adding stops (typed, scanned, voice, pin,
// import). Pure, so it is unit-tested.

import { findEircode } from './format';

/** Stops this close together are the same door. */
export const SAME_PLACE_METRES = 15;

type Point = { latitude: number; longitude: number };
/** The parts of a saved stop the check needs (a `Delivery` fits). */
export type StopLike = {
  id: string;
  address: { raw: string; normalized: string | null; postalCode: string | null; latitude: number | null; longitude: number | null; approximate: boolean; geocodeStatus: string };
};
/** The stop about to be added: its Eircode if known, and its point if it is a precise one. */
export type NewStop = { eircode?: string | null; point?: Point | null };
export type Duplicate<T extends StopLike> = { stop: T; index: number; reason: 'eircode' | 'distance'; eircode: string | null };

/** Metres between two points (haversine). */
export function distanceMetres(a: Point, b: Point) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** The Eircode of a saved stop: the one the map returned, else one in its text. */
export const stopEircode = (stop: StopLike) => stop.address.postalCode || findEircode(stop.address.raw) || findEircode(stop.address.normalized);

/** A saved point is only used for the distance rule when the map placed it exactly (not an area centre). */
const precisePoint = (stop: StopLike): Point | null =>
  stop.address.latitude != null && stop.address.longitude != null && stop.address.geocodeStatus === 'found' && !stop.address.approximate
    ? { latitude: stop.address.latitude, longitude: stop.address.longitude } : null;

/**
 * The first saved stop the new one duplicates, or null. Duplicate means the same Eircode, or within 15 m of a precisely
 * placed stop. Two stops with different Eircodes are never duplicates, even next door (flats in one building).
 */
export function findDuplicate<T extends StopLike>(next: NewStop, stops: readonly T[]): Duplicate<T> | null {
  const code = next.eircode ? findEircode(next.eircode) : null;
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    const theirs = stopEircode(stop);
    if (code && theirs === code) return { stop, index, reason: 'eircode', eircode: code };
    if (code && theirs && theirs !== code) continue;
    const at = precisePoint(stop);
    if (next.point && at && distanceMetres(next.point, at) <= SAME_PLACE_METRES) return { stop, index, reason: 'distance', eircode: theirs };
  }
  return null;
}
