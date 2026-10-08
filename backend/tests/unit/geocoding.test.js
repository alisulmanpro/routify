import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localityQueries } from '../../src/services/geocoding.service.js';

test('locality fallback strips country and province suffixes before querying places', () => {
  const wordAddress = localityQueries('DHQ Hospital Narowal Punjab Pakistan');
  assert.equal(wordAddress.at(-1), 'Narowal');
  assert.ok(wordAddress.every((query) => !/Punjab|Pakistan/i.test(query)));

  const commaAddress = localityQueries('House 14, Main Bazar, Narowal, Punjab, Pakistan');
  assert.equal(commaAddress.at(-1), 'House 14, Main Bazar, Narowal');
  assert.ok(commaAddress.every((query) => !/Punjab|Pakistan/i.test(query)));
});
test('service area covers the metro area but not other cities or continents', async () => {
  const { isInsideArea } = await import('../../src/services/geocoding.service.js');
  const narowal = { latitude: 32.1009, longitude: 74.8722 };
  assert.ok(isInsideArea({ latitude: 32.2, longitude: 74.95 }, narowal));
  assert.ok(!isInsideArea({ latitude: 31.5204, longitude: 74.3587 }, narowal), 'Lahore is a different city');
  assert.ok(!isInsideArea({ latitude: 45.4285, longitude: -75.7139 }, narowal), 'Gatineau, Canada');
  assert.ok(isInsideArea({ latitude: 45.4, longitude: -75.7 }, null), 'no area means no restriction');
});
