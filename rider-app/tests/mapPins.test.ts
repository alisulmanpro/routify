import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleStops } from '../src/lib/mapPins';

type K = 'next' | 'current' | 'upcoming' | 'last' | 'done' | 'failed';
const route = (open: number, done: number) => [
  ...Array.from({ length: open }, (_, i) => ({ id: `o${i}`, kind: (i === 0 ? 'next' : i === open - 1 ? 'last' : 'upcoming') as K })),
  ...Array.from({ length: done }, (_, i) => ({ id: `d${i}`, kind: 'done' as K })),
];

test('a 200-stop route draws the next 25 open pins and the final stop', () => {
  const shown = visibleStops(route(200, 0), 25);
  assert.equal(shown.length, 26);
  assert.deepEqual(shown.slice(0, 3).map((s) => s.id), ['o0', 'o1', 'o2']);
  assert.equal(shown[25].id, 'o199');
});

test('finished pins fill the room left near the end of a route', () => {
  const shown = visibleStops(route(10, 190), 25);
  assert.equal(shown.length, 25);
  assert.equal(shown.filter((s) => s.kind === 'done').length, 15);
});

test('small routes and no limit draw everything', () => {
  assert.equal(visibleStops(route(12, 3), 25).length, 15);
  assert.equal(visibleStops(route(200, 0)).length, 200);
});
