import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeAddress, fieldsAddress, findParcelLine, labelFields, mergeFields, readLabel } from '../src/lib/labelText';
import { readingOrder } from '../src/lib/ocrOrder';
import { addressKey } from '../src/lib/irishAddress';

test('reads an Irish label into address, recipient and parcel ID', () => {
  const r = readLabel(['TO: AOIFE MURPHY', '87 CLONSKEAGH ROAD', 'CLONSKEAGH', 'DUBLIN 6', 'D06 YP22', 'IRELAND', 'AWB: 7781234567']);
  assert.equal(r.address, '87 CLONSKEAGH ROAD, CLONSKEAGH, DUBLIN 6, D06 YP22, IRELAND');
  assert.equal(r.name, 'AOIFE MURPHY');
  assert.equal(r.parcelId, '7781234567');
  assert.equal(r.parts?.eircode, 'D06 YP22');
  assert.equal(r.rawLines.length, 7, 'original OCR lines are kept');
});

test('never takes an Eircode or an address line as the parcel ID', () => {
  assert.equal(findParcelLine(['87 CLONSKEAGH ROAD', 'T45XP21', 'D06 YP22']), -1);
  const r = readLabel(['87 CLONSKEAGH ROAD', 'CLONSKEAGH', 'DUBLIN 6', 'T45XP21']);
  assert.notEqual(r.parcelId, 'T45XP21');
  assert.notEqual(r.parcelId, '87CLONSKEAGHROAD');
});

test('still reads non-Irish labels with the generic rules', () => {
  const r = readLabel(['Ship To:', 'Ali Khan', 'House 12, Street 5, Block C', 'Gulberg III, Lahore', '0300-1234567']);
  assert.equal(r.address, 'House 12, Street 5, Block C, Gulberg III, Lahore');
  assert.equal(r.parts, null);
});

test('reading order follows the label, even when it is tilted', () => {
  // Three lines of a label turned 30°: on screen the third line sits left of the first.
  const angle = 30;
  const rad = (angle * Math.PI) / 180;
  const at = (x: number, y: number) => ({ x: x * Math.cos(rad) - y * Math.sin(rad), y: x * Math.sin(rad) + y * Math.cos(rad) });
  const line = (text: string, x: number, y: number) => {
    const c = at(x, y);
    return { text, frame: { left: c.x - 40, top: c.y - 8, width: 80, height: 16 } };
  };
  const shuffled = [line('DUBLIN 6', 100, 80), line('TO: AOIFE MURPHY', 100, 0), line('87 CLONSKEAGH ROAD', 100, 40)];
  assert.deepEqual(readingOrder(shuffled, angle), ['TO: AOIFE MURPHY', '87 CLONSKEAGH ROAD', 'DUBLIN 6']);
});

test('reading order keeps words on the same row left to right', () => {
  const lines = [
    { text: 'IE-DUB', frame: { left: 300, top: 0, width: 60, height: 20 } },
    { text: 'TO: SEAN', frame: { left: 0, top: 2, width: 100, height: 20 } },
    { text: '14 MERLYN PARK', frame: { left: 0, top: 40, width: 140, height: 20 } },
  ];
  assert.deepEqual(readingOrder(lines, 0), ['TO: SEAN', 'IE-DUB', '14 MERLYN PARK']);
});

test('duplicate check matches the same address however it was spaced or cased', () => {
  assert.equal(addressKey('87 Clonskeagh Road, Dublin 6, D06YP22'), addressKey('87 CLONSKEAGH ROAD, CLONSKEAGH, DUBLIN 6, D06 YP22, IRELAND'));
  assert.equal(addressKey('12 Main St, Bray'), addressKey('12  main st,bray'));
  assert.notEqual(addressKey('12 Main St, Bray'), addressKey('14 Main St, Bray'));
});

test('scanner fields: only name, address lines and Eircode', () => {
  const f = labelFields(readLabel(['AN POST', 'TRACKING 7781234567', 'TO:', 'SEAN KELLY', '12 MAIN STREET', 'BALLINCOLLIG', 'CO. CORK', 'P31 X2Y4', 'IRELAND', 'AWB: 7781234567']));
  assert.equal(f.name, 'SEAN KELLY');
  assert.equal(f.postalCode, 'P31 X2Y4');
  assert.equal(fieldsAddress(f), '12 MAIN STREET, BALLINCOLLIG, CO. CORK, IRELAND');
  assert.ok(!/7781234567|AN POST/.test(`${f.name} ${fieldsAddress(f)} ${f.postalCode}`), 'tracking IDs and headers are left out');
  assert.equal(composeAddress(f), '12 MAIN STREET, BALLINCOLLIG, CO. CORK, P31 X2Y4, IRELAND');
});

test('scanner fields: no Eircode on the label means no postal code', () => {
  const f = labelFields(readLabel(['TO: JOHN SMITH', 'House 12 Street 4', 'Block B Model Town', 'Lahore']));
  assert.equal(f.postalCode, null);
});
