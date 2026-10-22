import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEventToRoute, applyStopEvent, earlierStopOf, toDelivery, toRoute, type V2Route, type V2Stop } from '../src/lib/v2';

const stop = (id: string, over: Partial<V2Stop> = {}): V2Stop => ({
  id, order: 1, status: 'pending', trackingId: 'P-1', customerName: 'Mary',
  address: { raw: '1 Main St', normalized: '1 Main Street, Dublin', latitude: 53.3, longitude: -6.3, geocoded: true, approximate: false, geocodeStatus: 'found', postalCode: 'D01 F5P2' },
  legDistanceKm: 1.2, legDurationMin: 4, failureReason: null, deliveredAt: null, failedAt: null, ...over,
});

const route = (stops: V2Stop[]): V2Route => ({
  id: 'r1', name: 'Monday', status: 'active', serviceDate: '2026-10-23', preference: 'smart', optimization: 'road',
  origin: null, distanceKm: 5, durationMin: 30, progress: { total: stops.length, done: 0, remaining: stops.length },
  summary: { total: stops.length, delivered: 0, failed: 0, pending: stops.length, distanceKm: 5, routeMinutes: null }, nextStopId: stops[0]?.id ?? null, stops,
});

test('a v2 route becomes the Route the screens use, with every field they read', () => {
  const r = toRoute(route([stop('a'), stop('b', { order: 2, status: 'delivered', deliveredAt: '2026-10-23T10:00:00.000Z' })]), 'W/"x"');
  assert.equal(r.etag, 'W/"x"');
  assert.equal(r.currentStopId, 'a');
  assert.deepEqual(r.stops.map((s) => [s.order, s.delivery.id, s.delivery.routeId, s.delivery.serviceDate]), [[1, 'a', 'r1', '2026-10-23'], [2, 'b', 'r1', '2026-10-23']]);
  const d = r.stops[1].delivery;
  assert.equal(d.status, 'delivered');
  assert.equal(d.customer.name, 'Mary');
  assert.equal(d.address.postalCode, 'D01 F5P2');
  assert.equal(r.stops[0].legDistanceKm, 1.2);
});

test('flags and failure follow the v1 rules', () => {
  const d = toDelivery(stop('a', { status: 'failed', failureReason: 'wrong_address', address: { ...stop('a').address, geocodeStatus: 'not_found', approximate: true } }),
    { serviceDate: '2026-10-23', routeId: null });
  assert.deepEqual(d.flags, ['location_not_found', 'approximate_location']);
  assert.deepEqual(d.failure, { reason: 'wrong_address', note: null });
});

test('a stop event updates the full delivery but keeps what v2 does not send', () => {
  const full = { ...toDelivery(stop('a'), { serviceDate: '2026-10-23', routeId: 'r1' }), note: 'Gate code 1234', customer: { name: 'Mary', phone: '0871234567' } };
  const after = applyStopEvent(full, stop('a', { status: 'delivered', deliveredAt: '2026-10-23T10:00:00.000Z' }));
  assert.equal(after.status, 'delivered');
  assert.equal(after.note, 'Gate code 1234');
  assert.equal(after.customer.phone, '0871234567');
  assert.ok(after.arrivedAt);
});

test('the earlier open stop is read from the error details', () => {
  assert.deepEqual(earlierStopOf([{ trackingId: 'P-7', stopOrder: 3 }]), { trackingId: 'P-7', stopOrder: 3 });
  assert.equal(earlierStopOf([]), null);
  assert.equal(earlierStopOf(undefined), null);
});

test('a stop event updates the saved route without reloading it', () => {
  const r = toRoute(route([stop('a'), stop('b', { order: 2 })]), 'W/"old"');
  const after = applyEventToRoute(r, {
    stop: stop('a', { status: 'delivered', deliveredAt: '2026-10-23T10:00:00.000Z' }),
    route: { id: 'r1', status: 'active', nextStopId: 'b', progress: { total: 2, done: 1, remaining: 1 },
      summary: { total: 2, delivered: 1, failed: 0, pending: 1, distanceKm: 5, routeMinutes: null } },
  });
  assert.equal(after.stops[0].delivery.status, 'delivered');
  assert.equal(after.currentStopId, 'b');
  assert.deepEqual(after.progress, { total: 2, done: 1, remaining: 1 });
  assert.equal((after as { etag?: string }).etag, undefined);
  // Another route's stop leaves this route as it is.
  assert.equal(applyEventToRoute(r, { stop: stop('zz'), route: null }), r);
});
