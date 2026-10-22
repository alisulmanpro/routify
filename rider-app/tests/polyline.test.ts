import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline } from '../src/lib/polyline';

test('decodes the reference polyline from Google\'s format docs', () => {
  // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    { latitude: 38.5, longitude: -120.2 },
    { latitude: 40.7, longitude: -120.95 },
    { latitude: 43.252, longitude: -126.453 },
  ]);
  assert.deepEqual(decodePolyline(''), []);
});
