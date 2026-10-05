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