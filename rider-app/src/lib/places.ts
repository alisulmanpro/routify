import { newId, post } from './api';

/** A suggestion while typing (POST /v2/places/autocomplete). With Google the point is not known until it is picked. */
export type PlaceSuggestion = { placeId: string | null; label: string; latitude: number | null; longitude: number | null; approximate: boolean };
/** A picked suggestion's point. `normalized` is the address Google has for it (keeps its Eircode for the stop). */
export type PlacePoint = { label: string; latitude: number; longitude: number; approximate: boolean; normalized: string | null };

type Near = { latitude: number; longitude: number } | null;

/**
 * A billing session for one address being typed (P5.1): the same token goes with every keystroke's search and with the
 * pick, which ends the session; then a new one starts. Google bills the searches in a session that ends in Place
 * Details per request (cheap Autocomplete SKU), not per keystroke at the Text Search Pro price.
 */
export const newPlaceSession = () => newId();

export async function searchPlaces(input: string, session: string, near: Near, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const res = await post<{ suggestions: PlaceSuggestion[] }>('/v2/places/autocomplete', { input, sessionToken: session, ...(near || {}) }, signal);
  return res.data.suggestions;
}

/** The point of a picked suggestion: at once when the suggestion has it, else one Place Details request (ends the session). */
export async function pickPlace(suggestion: PlaceSuggestion, session: string): Promise<PlacePoint | null> {
  if (suggestion.latitude != null && suggestion.longitude != null) {
    return { label: suggestion.label, latitude: suggestion.latitude, longitude: suggestion.longitude, approximate: suggestion.approximate, normalized: null };
  }
  if (!suggestion.placeId) return null;
  const res = await post<{ found: boolean; latitude: number | null; longitude: number | null; normalized: string | null; approximate: boolean }>(
    '/v2/places/details', { placeId: suggestion.placeId, sessionToken: session });
  const d = res.data;
  return d.found && d.latitude != null && d.longitude != null
    ? { label: suggestion.label, latitude: d.latitude, longitude: d.longitude, approximate: d.approximate, normalized: d.normalized }
    : null;
}
