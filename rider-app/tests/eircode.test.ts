import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eircodesInText, findEircodes, normalizeEircode } from '../src/lib/scan/eircode';

test('spaced, unspaced and lower-case codes, alone or inside a line', () => {
  assert.deepEqual(findEircodes('R93 Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('R93Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('r93 y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('Leighlinbridge, Co. Carlow R93 Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('D6W XY12'), ['D6W XY12']);
  assert.deepEqual(findEircodes('D15DK4A'), ['D15 DK4A']);
});

test('the printed caption "EIRCODE" is ignored, never part of the result', () => {
  assert.deepEqual(findEircodes('EIRCODE R93 Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('Eircode: R93Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('EIRCODE:R93 Y201'), ['R93 Y201']);
  assert.deepEqual(findEircodes('EIRCODE'), []);
  assert.deepEqual(findEircodes('Eir Code'), []);
});

test('OCR look-alikes are fixed by position', () => {
  const cases: [string, string][] = [
    ['R93 Y2O1', 'R93 Y201'], ['R93 Y2D1', 'R93 Y2D1'], ['R9S Y201', 'R95 Y201'], ['DO6 YP22', 'D06 YP22'], ['D0G YP22', 'D06 YP22'],
    ['0O6 YP22', 'D06 YP22'], ['N37 YSVH', 'N37 Y5VH'], ['A92 EDVVE', 'A92 EDWE'], ['P31 ABPN', 'P31 A8PN'], ['K67 RIG5', 'K67 R165'],
    ['T12 6ODD', 'T12 60DD'], ['V9S V28P', 'V95 V28P'], ['A9Z EDWE', 'A92 EDWE'], ['A9 2EDWE', 'A92 EDWE'], ['DI5 DK4A', 'D15 DK4A'],
  ];
  for (const [read, want] of cases) assert.deepEqual(findEircodes(read), [want], read);
});

test('phone numbers, parcel IDs, order numbers and words never match', () => {
  for (const text of [
    '087 123 4567', '+353 87 123 4567', '01 234 5678', '0871234567', '129734', 'Parcel ID 129734', 'CE123456789IE', '1Z999AA10123456784',
    'Order #4410-9921', 'ORD-4410-9921', 'ORDER 12345678', 'Ref: A12 3456', 'DOLPHIN', 'DUBLIN 6', 'BALLYKNOCKAN', 'IRELAND', 'TEST-002',
    'No 5 Main St', 'Apt 12 Main Street', 'B12 3456', 'Z99 ABCD', 'R93 Y20', '€24.99',
  ]) {
    assert.deepEqual(findEircodes(text), [], text);
  }
});

test('repairs never invent a code: at most two fixes, and only onto a real routing key', () => {
  assert.deepEqual(findEircodes('C9O AC4D'), [], 'C90 is not a routing key');
  assert.deepEqual(findEircodes('OOO OOOO'), [], 'too many fixes');
});

test('a whole frame of label text gives only its distinct Eircodes', () => {
  const frame = ['ROUTE 12', 'Mary Byrne', '36 Ballyknockan Manor', 'Leighlinbridge, Co. Carlow', 'EIRCODE R93 Y201', 'Tel 087 123 4567', 'R93Y201', '129734'].join('\n');
  assert.deepEqual(eircodesInText(frame), ['R93 Y201']);
  assert.deepEqual(eircodesInText('FROM D18 K2P1\nTO V95 V28P'), ['D18 K2P1', 'V95 V28P']);
  assert.deepEqual(eircodesInText(''), []);
});

test('normalises any spelling to "XXX XXXX"', () => {
  assert.equal(normalizeEircode('r93y201'), 'R93 Y201');
  assert.equal(normalizeEircode('R93-Y201'), 'R93 Y201');
  assert.equal(normalizeEircode('B12 3456'), null);
});
