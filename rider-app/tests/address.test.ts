import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAddressText, expandForSearch, houseNumber, issueText, rankSuggestions, streetType, suggestionIssues } from '../src/lib/scan/address';

// The client's test addresses (Clondalkin, Dublin 22): four streets that differ only by their type.
const CLIENT = [
  ['26 Shanecastle dr clondalkin dublin 22', 'drive'],
  ['26 shanecastle cl clondalkin dublin 22', 'close'],
  ['26 shanecastle grove clondalkin dublin 22', 'grove'],
  ['22shanecasgle cre dublin 22', 'crescent'],
] as const;

test('the client test addresses: each street type is told apart', () => {
  for (const [text, type] of CLIENT) assert.equal(streetType(text), type, text);
});

test('spacing the camera dropped is put back; Eircodes, ordinals and house letters are kept', () => {
  assert.equal(cleanAddressText('26shanecastle grove'), '26 shanecastle grove');
  assert.equal(cleanAddressText('22shanecasgle cre dublin22'), '22 shanecasgle cre dublin 22');
  assert.equal(cleanAddressText('26A Main St'), '26A Main St');
  assert.equal(cleanAddressText('1st Avenue'), '1st Avenue');
  assert.equal(cleanAddressText('Leighlinbridge R93Y201'), 'Leighlinbridge R93Y201');
  assert.equal(cleanAddressText('Unit 4 D15 DKA4'), 'Unit 4 D15 DKA4');
});

test('clear OCR slips in short forms are fixed, lines are joined', () => {
  assert.equal(cleanAddressText('26 Shanecastle C1'), '26 Shanecastle Cl');
  assert.equal(cleanAddressText('26 Shanecastle CI,'), '26 Shanecastle Cl');
  assert.equal(cleanAddressText('12 Main 5t'), '12 Main St');
  assert.equal(cleanAddressText('26 Shanecastle Grove\nClondalkin\n\nDublin 22'), '26 Shanecastle Grove, Clondalkin, Dublin 22');
  assert.equal(cleanAddressText('  *26 Main St*  '), '26 Main St');
});

test('street type: the last type word of the street part, not a name that happens to be one', () => {
  assert.equal(streetType('26 Shanecastle Grove, Clondalkin, Dublin 22'), 'grove');
  assert.equal(streetType('26 Shanecastle Park, Clondalkin, Dublin 22, Ireland'), 'park');
  assert.equal(streetType('5 Park Avenue, Dublin 4'), 'avenue');
  assert.equal(streetType('Hill Street, Dublin 1'), 'street');
  assert.equal(streetType('3 Oak Park Dr, Rathfarnham'), 'drive');
  assert.equal(streetType('The Grove, Celbridge'), 'grove');
  assert.equal(streetType('Clondalkin, Dublin 22'), null);
  assert.equal(streetType('D22 XY12'), null);
  assert.equal(streetType('Bóthar Mhuire, Co Galway'), 'road');
});

test('"St" and "Dr" after the house number are titles, at the end they are the street type', () => {
  assert.equal(streetType("26 St Mary's Rd, Dublin 12"), 'road');
  assert.equal(streetType('14 Main St, Lucan'), 'street');
  assert.equal(expandForSearch("26 St Mary's Rd, Dublin 12"), "26 Saint Mary's Road, Dublin 12");
  assert.equal(expandForSearch('14 Main St, Lucan'), '14 Main Street, Lucan');
});

test('house number: apartment numbers, Dublin districts and Eircodes are skipped', () => {
  assert.equal(houseNumber('26 Shanecastle Grove, Dublin 22'), '26');
  assert.equal(houseNumber('26a Main St'), '26a');
  assert.equal(houseNumber('Apt 4, 26 Main St'), '26');
  assert.equal(houseNumber('Shanecastle Grove, Dublin 22'), null);
  assert.equal(houseNumber('D22 XY12'), null);
  assert.equal(houseNumber('26-28 Main St'), '26');
});

test('search text: short forms written out, Eircode last', () => {
  assert.equal(expandForSearch('26 shanecastle cl clondalkin dublin 22'), '26 shanecastle Close clondalkin dublin 22');
  assert.equal(expandForSearch('22shanecasgle cre dublin 22'), '22 shanecasgle Crescent dublin 22');
  assert.equal(expandForSearch('4 Main St Upr, Co Dublin'), '4 Main Street Upper, County Dublin');
  assert.equal(expandForSearch('26 Grove Rd D22 XY12'), '26 Grove Road D22 XY12');
  assert.equal(expandForSearch('D22 XY12'), 'D22 XY12');
});

test('suggestion issues: a different street type or house number is flagged, a missing one is not', () => {
  const asked = '26 shanecastle grove clondalkin dublin 22';
  assert.deepEqual(suggestionIssues(asked, '26 Shanecastle Park, Clondalkin, Dublin 22, Ireland'), [{ kind: 'street', wanted: 'grove', got: 'park' }]);
  assert.deepEqual(suggestionIssues(asked, '26 Shanecastle Grove, Clondalkin, Dublin 22, Ireland'), []);
  assert.deepEqual(suggestionIssues(asked, 'Shanecastle Grove, Clondalkin, Dublin 22, Ireland'), []);
  assert.deepEqual(suggestionIssues(asked, '22 Shanecastle Grove, Clondalkin, Dublin 22'), [{ kind: 'number', wanted: '26', got: '22' }]);
  assert.deepEqual(suggestionIssues('26 shanecastle cl', '26 Shanecastle Close, Dublin 22'), []);
  assert.deepEqual(suggestionIssues('shanecastle', '26 Shanecastle Park, Dublin 22'), []);
  assert.equal(issueText({ kind: 'street', wanted: 'grove', got: 'park' }), 'Park, not Grove');
  assert.equal(issueText({ kind: 'number', wanted: '26', got: '22a' }), 'No. 22A, not 26');
});

test('ranking: matching suggestions first, the rest after, order otherwise kept', () => {
  const list = [
    '26 Shanecastle Park, Clondalkin, Dublin 22',
    '26 Shanecastle Drive, Clondalkin, Dublin 22',
    '26 Shanecastle Grove, Clondalkin, Dublin 22',
    'Shanecastle Grove, Clondalkin, Dublin 22',
  ];
  const ranked = rankSuggestions('26 shanecastle grove', list, (s) => s);
  assert.deepEqual(ranked.map((r) => r.item), [list[2], list[3], list[0], list[1]]);
  assert.deepEqual(ranked.map((r) => r.issues.length), [0, 0, 1, 1]);
});
