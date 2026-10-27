import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRow, lookupText, type Accepted, type AddressCheck } from '../src/lib/importCheck';
import type { StopLike } from '../src/lib/duplicates';

const found = (normalized: string, approximate = false, latitude = 53.3, longitude = -6.4, postalCode: string | null = null): AddressCheck =>
  ({ found: true, approximate, latitude, longitude, normalized, postalCode });
const missing: AddressCheck = { found: false, approximate: false, latitude: null, longitude: null, normalized: null, postalCode: null };

test('a row the map places at the door, on the street asked for, is ready', () => {
  const row = checkRow('26 Shanecastle Grove, Clondalkin, Dublin 22', found('26 Shanecastle Grove, Clondalkin, Dublin 22, Ireland'), [], []);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.status === 'ready' && row.point, { latitude: 53.3, longitude: -6.4 });
});

test('short forms in the file match the long forms on the map', () => {
  assert.equal(checkRow('26 shanecastle cl dublin 22', found('26 Shanecastle Close, Dublin 22, Ireland'), [], []).status, 'ready');
  assert.equal(lookupText('26 shanecastle cl dublin 22'), '26 shanecastle Close dublin 22');
  assert.equal(lookupText('d22yx12'), 'd22yx12');
});

test('the map on a different street type or number: not added, says what it found', () => {
  const row = checkRow('26 Shanecastle Grove, Dublin 22', found('26 Shanecastle Park, Dublin 22, Ireland'), [], []);
  assert.equal(row.status, 'problem');
  assert.equal(row.status === 'problem' && row.issue, 'different');
  assert.match(row.status === 'problem' ? row.detail : '', /Shanecastle Park.*Park, not Grove/);
});

test('not found, area only, too short and a failed lookup are problems', () => {
  const issue = (address: string, check: AddressCheck | null) => {
    const row = checkRow(address, check, [], []);
    return row.status === 'problem' ? row.issue : row.status;
  };
  assert.equal(issue('12 Nowhere Lane, Atlantis', missing), 'not_found');
  assert.equal(issue('Main Street, Lucan', found('Lucan, Co. Dublin, Ireland', true)), 'approximate');
  assert.equal(issue('D22', found('Dublin 22, Ireland')), 'incomplete');
  assert.equal(issue('26 Main Street, Lucan', null), 'lookup_failed');
  assert.equal(issue('26 Main Street, Lucan', { ...missing, error: true }), 'lookup_failed');
});

test('an Eircode on its own is the door even when the map has the area only', () => {
  assert.equal(checkRow('P12 FY70', found('Aghabullogue, Co. Cork, P12 FY70', true, 51.9, -8.8, 'P12 FY70'), [], []).status, 'ready');
});

test('a stop already on the list, or higher up in the file, is not added twice', () => {
  const existing: StopLike[] = [{
    id: 's1', address: { raw: 'P12 FY70', normalized: null, postalCode: 'P12 FY70', latitude: 51.9, longitude: -8.8, approximate: false, geocodeStatus: 'found' },
  }];
  const listed = checkRow('1 Church View, Aghabullogue P12FY70', found('1 Church View, Aghabullogue, Co. Cork, P12 FY70', false, 51.9, -8.8, 'P12 FY70'), existing, []);
  assert.equal(listed.status === 'problem' && listed.detail, 'Already in your stops (#1).');

  const earlier: Accepted[] = [{ id: 'r1', raw: '26 Main St, Lucan', normalized: null, eircode: null, point: { latitude: 53.35, longitude: -6.44 }, precise: true }];
  const again = checkRow('26 Main Street, Lucan', found('26 Main Street, Lucan, Ireland', false, 53.35, -6.44), [], earlier);
  assert.equal(again.status === 'problem' && again.detail, 'The same address is higher up in this file.');
});
