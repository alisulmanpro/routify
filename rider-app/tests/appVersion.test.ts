import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, updateNeeded } from '../src/lib/appVersion';

test('versions compare part by part as numbers', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.0.0', '2') < 0);
});

test('below min is required, below latest is suggested', () => {
  assert.equal(updateNeeded('1.0.0', '1.1.0', '1.2.0'), 'required');
  assert.equal(updateNeeded('1.1.0', '1.1.0', '1.2.0'), 'suggested');
  assert.equal(updateNeeded('1.2.0', '1.1.0', '1.2.0'), 'none');
  assert.equal(updateNeeded(null, '9.0.0', '9.0.0'), 'none');
  assert.equal(updateNeeded('1.0.0', undefined, undefined), 'none');
});
