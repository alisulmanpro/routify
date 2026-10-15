import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEircode, formatIrishAddress, isEircode, parseIrishAddress, splitForDisplay } from '../src/lib/irishAddress';

test('finds Eircodes with or without the space, and in a longer line', () => {
  assert.equal(findEircode('D06 YP22'), 'D06 YP22');
  assert.equal(findEircode('d06yp22'), 'D06 YP22');
  assert.equal(findEircode('DUBLIN 6 D06 YP22'), 'D06 YP22');
  assert.equal(findEircode('T45XP21'), 'T45 XP21');
  assert.equal(findEircode('D6W XY12'), 'D6W XY12');
});

test('repairs OCR look-alikes in the routing key only', () => {
  assert.equal(findEircode('DO6 YP22'), 'D06 YP22');
  assert.equal(findEircode('D0G YP22'), 'D06 YP22');
});

test('rejects text that only resembles an Eircode', () => {
  assert.equal(findEircode('B12 3456'), null, 'B is not a routing-key letter');
  assert.equal(findEircode('D06 YP2'), null);
  assert.equal(findEircode('7781234567'), null, 'barcode digits');
  assert.equal(isEircode('87 CLONSKEAGH ROAD'), false);
});

test('parses the example label into its parts', () => {
  const a = parseIrishAddress(['TO: AOIFE MURPHY', '87 CLONSKEAGH ROAD', 'CLONSKEAGH', 'DUBLIN 6', 'D06 YP22', 'IRELAND']);
  assert.equal(a.recipient, 'AOIFE MURPHY');
  assert.equal(a.street, '87 CLONSKEAGH ROAD');
  assert.equal(a.area, 'CLONSKEAGH');
  assert.equal(a.city, 'DUBLIN 6');
  assert.equal(a.eircode, 'D06 YP22');
  assert.equal(a.country, 'IRELAND');
  assert.ok(a.confidence >= 0.9);
  assert.deepEqual(a.issues, []);
});

test('ignores carrier text, sort codes and barcode digits around the address', () => {
  const a = parseIrishAddress(['an post', 'IE-DUB', "TO: SEAN O'CONNOR", '14 MERLYN PARK', 'BALLSBRIDGE', 'DUBLIN 4', 'D04 W2Y8', 'IRELAND', '2060000102308']);
  assert.equal(a.recipient, "SEAN O'CONNOR");
  assert.equal(a.street, '14 MERLYN PARK');
  assert.equal(a.area, 'BALLSBRIDGE');
  assert.equal(a.city, 'DUBLIN 4');
  assert.equal(a.eircode, 'D04 W2Y8');
});

test('keeps apartment lines and county lines, and works without a TO label', () => {
  const a = parseIrishAddress(['Mary Byrne', 'Apt 12 The Sorrento', '3 Main Street', 'Bray', 'Co. Wicklow', 'A98 X2Y3']);
  assert.equal(a.recipient, 'Mary Byrne');
  assert.equal(a.building, 'Apt 12 The Sorrento');
  assert.equal(a.street, '3 Main Street');
  assert.equal(a.city, 'Bray');
  assert.equal(a.county, 'Co. Wicklow');
  assert.equal(a.eircode, 'A98 X2Y3');
});

test('reports missing parts instead of inventing them', () => {
  const a = parseIrishAddress(['TO: JOHN', 'GALWAY']);
  assert.equal(a.eircode, null);
  assert.ok(a.issues.includes('Missing Eircode'));
  assert.ok(a.confidence < 0.5);
});

test('formats parts without losing spaces', () => {
  const raw = formatIrishAddress({ building: null, street: '87 CLONSKEAGH ROAD', area: 'CLONSKEAGH', city: 'DUBLIN 6', county: null, eircode: 'D06 YP22', country: 'IRELAND' });
  assert.equal(raw, '87 CLONSKEAGH ROAD, CLONSKEAGH, DUBLIN 6, D06 YP22, IRELAND');
});

test('splits a saved address for display', () => {
  assert.deepEqual(splitForDisplay('87 CLONSKEAGH ROAD, CLONSKEAGH, DUBLIN 6, D06 YP22, IRELAND'), { first: '87 CLONSKEAGH ROAD', rest: 'CLONSKEAGH, DUBLIN 6', eircode: 'D06 YP22' });
  assert.deepEqual(splitForDisplay('House 12, Gulberg III, Lahore'), { first: 'House 12', rest: 'Gulberg III, Lahore', eircode: null });
});
