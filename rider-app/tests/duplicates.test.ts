import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres, findDuplicate, type StopLike } from '../src/lib/duplicates';

const stop = (id: string, over: Partial<StopLike['address']> = {}): StopLike => ({
  id,
  address: { raw: '', normalized: null, postalCode: null, latitude: null, longitude: null, approximate: false, geocodeStatus: 'found', ...over },
});
// 36 Ballyknockan Manor (R93 Y201), and a point about 10 m east of it.
const HOUSE = { latitude: 52.7362, longitude: -6.9783 };
const TEN_M_EAST = { latitude: 52.7362, longitude: -6.97815 };
const NEXT_STREET = { latitude: 52.7372, longitude: -6.9783 };

test('same Eircode: from the map postcode, or written in the saved text', () => {
  const stops = [stop('a', { raw: 'D04 W2Y8' }), stop('b', { raw: 'R93 Y201', postalCode: 'R93 Y201' })];
  assert.deepEqual(findDuplicate({ eircode: 'r93y201' }, stops), { stop: stops[1], index: 1, reason: 'eircode', eircode: 'R93 Y201' });
  const typed = [stop('c', { raw: '36 Ballyknockan Manor, R93 Y201' })];
  assert.equal(findDuplicate({ eircode: 'R93 Y201' }, typed)?.reason, 'eircode');
  assert.equal(findDuplicate({ eircode: 'D06 YP22' }, stops), null);
});

test('within 15 m of a precisely placed stop', () => {
  assert.ok(distanceMetres(HOUSE, TEN_M_EAST) < 15);
  assert.ok(distanceMetres(HOUSE, NEXT_STREET) > 100);
  const stops = [stop('a', { raw: '36 Ballyknockan Manor', ...HOUSE })];
  assert.equal(findDuplicate({ point: TEN_M_EAST }, stops)?.reason, 'distance');
  assert.equal(findDuplicate({ point: NEXT_STREET }, stops), null);
});

test('area-level points are never "the same door"', () => {
  assert.equal(findDuplicate({ point: TEN_M_EAST }, [stop('a', { ...HOUSE, approximate: true })]), null);
  assert.equal(findDuplicate({ point: TEN_M_EAST }, [stop('a', { ...HOUSE, geocodeStatus: 'approximate' })]), null);
  assert.equal(findDuplicate({ point: null }, [stop('a', HOUSE)]), null);
});

test('different Eircodes next door are not duplicates (flats in one building)', () => {
  const stops = [stop('a', { postalCode: 'D02 X285', ...HOUSE })];
  assert.equal(findDuplicate({ eircode: 'D02 X286', point: TEN_M_EAST }, stops), null);
  // Without an Eircode on one side, the distance rule still applies.
  assert.equal(findDuplicate({ point: TEN_M_EAST }, stops)?.reason, 'distance');
});
