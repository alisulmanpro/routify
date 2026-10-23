/** Which stop pins the map draws. Pure (unit-tested in tests/mapPins.test.ts). */
type Pin = { kind: 'next' | 'current' | 'upcoming' | 'last' | 'done' | 'failed' };

const OPEN_KINDS = new Set<Pin['kind']>(['next', 'current', 'upcoming', 'last']);

/**
 * At most `maxStops` pins: the next open stops in order plus the final stop, then finished ones if there is room.
 * Hundreds of custom-view pins make the map slow; the rider only needs what is coming up. All pins when unset.
 */
export function visibleStops<T extends Pin>(stops: T[], maxStops?: number): T[] {
  if (maxStops == null || stops.length <= maxStops) return stops;
  const open = stops.filter((st) => OPEN_KINDS.has(st.kind));
  const shown = open.slice(0, maxStops);
  const last = open.find((st) => st.kind === 'last');
  if (last && !shown.includes(last)) shown.push(last);
  const room = Math.max(0, maxStops - shown.length);
  return [...shown, ...stops.filter((st) => !OPEN_KINDS.has(st.kind)).slice(0, room)];
}
