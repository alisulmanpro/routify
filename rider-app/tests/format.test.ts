import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopCardText } from '../src/lib/format';

test('a picked suggestion and the map address that only differ by short forms show once', () => {
  const card = stopCardText({ address: {
    raw: 'Library Hall, Church Street, Tullamore, County Offaly, Ireland',
    normalized: 'Library Hall, Church St, Tullamore, Co. Offaly, Ireland', postalCode: null,
  } });
  assert.deepEqual(card, { title: 'Library Hall, Church Street, Tullamore, County Offaly', address: '' });
});

test('a place name the map address does not start with is still kept in front', () => {
  const card = stopCardText({ address: {
    raw: 'Department of Justice',
    normalized: '51 St Stephen\'s Green, Dublin 2, D02 HK52, Ireland', postalCode: 'D02 HK52',
  } });
  assert.deepEqual(card, { title: 'D02 HK52', address: 'Department of Justice, 51 St Stephen\'s Green, Dublin 2' });
});
