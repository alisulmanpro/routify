import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofResize } from '../src/lib/photoSize';

test('large photos are scaled down on their longest side', () => {
  assert.deepEqual(proofResize(4032, 3024), { width: 1600 });
  assert.deepEqual(proofResize(3024, 4032), { height: 1600 });
});

test('small photos and unknown sizes are left as they are', () => {
  assert.equal(proofResize(1200, 900), null);
  assert.equal(proofResize(undefined, 900), null);
});
