import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute } from '../../src/services/route-planner.service.js';

const stop = (id, latitude, longitude) => ({ id, latitude, longitude, addressKey: id });

test('visits every stop exactly once', () => {
  const stops = [stop('a', 24.86, 67.01), stop('b', 24.90, 67.05), stop('c', 24.80, 66.99), stop('d', 24.95, 67.10)];
  const plan = planRoute({ origin: { latitude: 24.85, longitude: 67.0 }, stops, preference: 'shortest' });
  assert.deepEqual([...plan.order].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(plan.legs.length, 4);
  assert.ok(plan.distanceKm > 0);
});

test('nearest-first ordering follows destination coordinates from the rider origin', () => {
  const stops = [stop('far', 0, 10), stop('near', 0, 1)];
  const plan = planRoute({ origin: { latitude: 0, longitude: 0 }, stops, preference: 'nearest_first' });
  assert.deepEqual(plan.order, ['near', 'far']);
});

test('groups stops at the same address under "smart"', () => {
  const stops = [
    { id: 'a', latitude: 24.86, longitude: 67.01, addressKey: 'same' },
    { id: 'b', latitude: 24.86, longitude: 67.01, addressKey: 'same' },
    { id: 'c', latitude: 24.95, longitude: 67.2, addressKey: 'other' },
  ];
  const plan = planRoute({ origin: { latitude: 24.85, longitude: 67.0 }, stops, preference: 'smart' });
  const posA = plan.order.indexOf('a');
  const posB = plan.order.indexOf('b');
  assert.equal(Math.abs(posA - posB), 1, 'same-address stops should be adjacent');
});

test('empty stop list returns an empty route', () => {
  const plan = planRoute({ origin: { latitude: 0, longitude: 0 }, stops: [], preference: 'smart' });
  assert.deepEqual(plan, { order: [], legs: [], distanceKm: 0, durationMin: 0 });
});
