import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLines, labelFields, labelKey, mergeFields, readLabel, type LabelFields } from '../src/lib/labelText';
import { findEircode, findEircodeDetail, findUkPostcode, isLabelNoise, matchCounty } from '../src/lib/irishAddress';

// OCR lines as ML Kit returns them for the labels in ocr_test_cartons.pdf: header, the TO block,
// the right-hand column (TEST-0xx, the code under the QR) mixed in by row.
const label = (name: string, street: string, town: string, county: string | null, eircode: string, test: string, code: string) => [
  'PARCEL - OCR TEST SAMPLE', `TO: ${name}`, test, street, town, ...(county ? [county] : []), eircode, 'IRELAND', code,
];
const fields = (lines: string[]) => labelFields(readLabel(lines));

const CASES = [
  { lines: label('CIAN BYRNE', '189 WILLOW PARK', 'BALLINCOLLIG', 'CO. CORK', 'P31 A8PN', 'TEST-001', 'OCR826688539'), name: 'CIAN BYRNE', street: '189 WILLOW PARK', city: 'BALLINCOLLIG', county: 'CO. CORK', postalCode: 'P31 A8PN' },
  { lines: label('EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE', 'TEST-002', 'OCR966647391'), name: 'EOIN DOHERTY', street: '155 HILLCREST CLOSE', city: 'DROGHEDA', county: 'CO. LOUTH', postalCode: 'A92 EDWE' },
  { lines: label('EOIN DOHERTY', '54 HILLCREST CLOSE', 'ATHLONE', 'CO. WESTMEATH', 'N37 Y5VH', 'TEST-003', '0CR853573823'), name: 'EOIN DOHERTY', street: '54 HILLCREST CLOSE', city: 'ATHLONE', county: 'CO. WESTMEATH', postalCode: 'N37 Y5VH' },
  { lines: label('TADHG GALLAGHER', '24 RIVERSIDE DRIVE', 'SWORDS', 'CO. DUBLIN', 'K67 R165', 'TEST-017', 'OCR822408848'), name: 'TADHG GALLAGHER', street: '24 RIVERSIDE DRIVE', city: 'SWORDS', county: 'CO. DUBLIN', postalCode: 'K67 R165' },
  { lines: label("LAURA O'SULLIVAN", '24 BEECH GROVE', 'DOUGLAS', null, 'T12 60DD', 'TEST-044', 'OCR203685265').flatMap((l) => (l === 'DOUGLAS' ? ['DOUGLAS', 'CORK'] : [l])), name: "LAURA O'SULLIVAN", street: '24 BEECH GROVE, DOUGLAS', city: 'CORK', county: null, postalCode: 'T12 60DD' },
  { lines: label('DARRAGH WALSH', '147 SEAVIEW TERRACE', 'ENNIS', 'CO. CLARE', 'V95 V28P', 'TEST-071', 'OCR523625982'), name: 'DARRAGH WALSH', street: '147 SEAVIEW TERRACE', city: 'ENNIS', county: 'CO. CLARE', postalCode: 'V95 V28P' },
  { lines: label('KATIE LYNCH', '54 ABBEY COURT', 'ATHLONE', 'CO. WESTMEATH', 'N37 VDYE', 'TEST-098', 'OCR863166250'), name: 'KATIE LYNCH', street: '54 ABBEY COURT', city: 'ATHLONE', county: 'CO. WESTMEATH', postalCode: 'N37 VDYE' },
];

test('test-sheet labels: only name, street, town, county and Eircode, without the label noise', () => {
  for (const c of CASES) {
    const f = fields(c.lines);
    assert.deepEqual(
      { name: f.name, street: f.street, city: f.city, county: f.county, postalCode: f.postalCode, country: f.country },
      { name: c.name, street: c.street, city: c.city, county: c.county, postalCode: c.postalCode, country: 'IRELAND' },
      c.lines.join(' | '),
    );
    assert.equal(f.confidence.postalCode, 'high');
    assert.equal(f.confidence.name, 'high');
    assert.ok(!/TEST|PARCEL|OCR|SAMPLE/.test(JSON.stringify([f.name, f.street, f.city, f.county])), 'noise kept out');
  }
});

test('tilted label: the Eircode is found even when the lines come back out of order', () => {
  const f = fields(['A92 EDWE', 'TEST-002', 'PARCEL - OCR TEST SAMPLE', 'TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'IRELAND', 'OCR966647391']);
  assert.equal(f.postalCode, 'A92 EDWE');
  assert.equal(f.name, 'EOIN DOHERTY');
  assert.equal(f.street, '155 HILLCREST CLOSE');
  assert.equal(f.city, 'DROGHEDA');
  assert.equal(f.county, 'CO. LOUTH');
});

test('a tracking code run into the name line is dropped', () => {
  const f = fields(['TO: EOIN DOHERTY TEST-002', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE', 'IRELAND']);
  assert.equal(f.name, 'EOIN DOHERTY');
});

test('Eircode look-alikes are repaired and flagged for a second look', () => {
  const cases: [string, string][] = [
    ['N37 YSVH', 'N37 Y5VH'], ['A92 EDVVE', 'A92 EDWE'], ['P31 ABPN', 'P31 A8PN'], ['K67 R1G5', 'K67 R165'],
    ['T12 6ODD', 'T12 60DD'], ['V9S V28P', 'V95 V28P'], ['A9Z EDWE', 'A92 EDWE'], ['0O6 YP22', 'D06 YP22'], ['A9 2EDWE', 'A92 EDWE'],
  ];
  for (const [read, want] of cases) assert.deepEqual(findEircodeDetail(read), { code: want, repaired: true }, read);
  assert.deepEqual(findEircodeDetail('A92 EDWE'), { code: 'A92 EDWE', repaired: false });
  assert.deepEqual(findEircodeDetail('A92EDWE'), { code: 'A92 EDWE', repaired: false });
  const f = fields(['TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDVVE', 'IRELAND']);
  assert.equal(f.postalCode, 'A92 EDWE');
  assert.equal(f.confidence.postalCode, 'low');
});

test('ordinary words and label codes are never read as Eircodes', () => {
  for (const text of ['DOLPHIN', 'DUBLIN 6', 'TEST-002', 'OCR966647391', '0CR966647391', 'ATHLONE', 'WEXFORD', 'HILLCREST CLOSE', 'IRELAND']) assert.equal(findEircode(text), null, text);
});

test('noise lines: headers, tracking codes, long digit runs, QR garble', () => {
  for (const line of ['PARCEL - OCR TEST SAMPLE', 'TEST-002', 'OCR966647391', '0CR966647391', 'OCR 966647391', '2060000102308', '▣▣▣ ▤▥ ▦']) assert.ok(isLabelNoise(line), line);
  for (const line of ['155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE', 'EOIN DOHERTY', 'APT 12', 'IRELAND']) assert.ok(!isLabelNoise(line), line);
});

test('misread county names are put right; unknown ones are flagged', () => {
  assert.deepEqual(matchCounty('LOUTN'), { county: 'LOUTH', distance: 1 });
  assert.deepEqual(matchCounty('WESTMEA TH'), { county: 'WESTMEATH', distance: 0 });
  assert.equal(matchCounty('BRAY'), null);
  const f = fields(['TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'C0. LOUTN', 'A92 EDWE', 'IRELAND']);
  assert.equal(f.county, 'CO. LOUTH');
  assert.equal(f.confidence.county, 'low');
});

test('a name guessed without a TO label is flagged', () => {
  const f = fields(['Mary Byrne', 'Apt 12 The Sorrento', '3 Main Street', 'Bray', 'Co. Wicklow', 'A98 X2Y3']);
  assert.equal(f.name, 'Mary Byrne');
  assert.equal(f.confidence.name, 'low');
  assert.equal(f.confidence.postalCode, 'high');
});

test('a missing Eircode is reported as missing, the rest is still returned', () => {
  const f = fields(['TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'IRELAND']);
  assert.equal(f.postalCode, null);
  assert.equal(f.confidence.postalCode, 'missing');
  assert.equal(f.street, '155 HILLCREST CLOSE');
  assert.equal(f.city, 'DROGHEDA');
});

test('UK postcodes on labels without an Eircode', () => {
  assert.equal(findUkPostcode('London SW1A 1AA'), 'SW1A 1AA');
  assert.equal(findUkPostcode('BT7 1NN'), 'BT7 1NN');
  assert.equal(findUkPostcode('A92 EDWE'), null);
  const f = fields(['Ship To:', 'John Smith', '10 Downing Street', 'London', 'SW1A 2AA']);
  assert.equal(f.postalCode, 'SW1A 2AA');
});

test('merging two readings: gaps are filled, agreement is trusted, disagreement is flagged', () => {
  const a = fields(['TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'A92 EDVVE']);
  const b = fields(['TO: EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE', 'IRELAND']);
  const merged = mergeFields([a, b])!;
  assert.equal(merged.county, 'CO. LOUTH');
  assert.equal(merged.postalCode, 'A92 EDWE');
  assert.equal(merged.confidence.postalCode, 'high', 'both readings agree');
  const c: LabelFields = { ...b, postalCode: 'A92 EDWF', confidence: { ...b.confidence } };
  assert.equal(mergeFields([b, c])!.confidence.postalCode, 'low');
});

test('QR codes with pipe-separated parts give every field, not just the Eircode', () => {
  const f = labelFields(readLabel(codeLines('TEST-002|Eoin Doherty|155 Hillcrest Close|Drogheda|Co. Louth|A92 EDWE')));
  assert.deepEqual([f.name, f.street, f.city, f.county, f.postalCode], ['Eoin Doherty', '155 Hillcrest Close', 'Drogheda', 'Co. Louth', 'A92 EDWE']);
  assert.deepEqual(codeLines('a\nb, c;d\te'), ['a', 'b', 'c', 'd', 'e']);
});

test('the name after a misread "TO:" or with a misread digit is still the name', () => {
  const rest = ['155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE', 'IRELAND'];
  assert.equal(fields(['IO: EOIN DOHERTY', ...rest]).name, 'EOIN DOHERTY');
  const zero = fields(['TO: E0IN DOHERTY', ...rest]);
  assert.equal(zero.name, 'E0IN DOHERTY');
  assert.equal(zero.street, '155 HILLCREST CLOSE');
  assert.equal(zero.confidence.name, 'low');
});

test('an Eircode read before the rest of the label still leaves street, town and county', () => {
  const f = fields(['A92 EDWE', 'EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'IRELAND']);
  assert.deepEqual([f.name, f.street, f.city, f.county, f.postalCode], ['EOIN DOHERTY', '155 HILLCREST CLOSE', 'DROGHEDA', 'CO. LOUTH', 'A92 EDWE']);
});

test('duplicate key: same Eircode and name match, a different person at the same Eircode does not', () => {
  const base = { street: '1 MAIN ST', city: 'DROGHEDA', county: null, country: null, postalCode: 'A92 EDWE' };
  assert.equal(labelKey({ ...base, name: 'Eoin Doherty' }), labelKey({ ...base, name: 'EOIN DOHERTY', postalCode: 'A92EDWE' }));
  assert.notEqual(labelKey({ ...base, name: 'EOIN DOHERTY' }), labelKey({ ...base, name: 'KATIE LYNCH' }));
  assert.notEqual(labelKey({ ...base, name: 'EOIN DOHERTY' }), labelKey({ ...base, name: 'EOIN DOHERTY', postalCode: 'N37 Y5VH' }));
});
