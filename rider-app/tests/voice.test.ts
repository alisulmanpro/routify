import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceToAddress } from '../src/lib/voice';

test('an Eircode heard in pieces is joined into one code', () => {
  assert.equal(voiceToAddress('P1 2 FY 70'), 'P12 FY70');
  assert.equal(voiceToAddress('p 12 f y 7 0'), 'P12 FY70');
  assert.equal(voiceToAddress('P one two FY seven zero'), 'P12 FY70');
  assert.equal(voiceToAddress('D 22 double Y 4 5'), 'D22 YY45');
  assert.equal(voiceToAddress('R35 T oh 2 1'), 'R35 T021');
});

test('the code inside an address keeps the words around it', () => {
  assert.equal(voiceToAddress('1 Church View Aghabullogue P1 2 FY 70'), '1 Church View Aghabullogue P12 FY70');
});

test('an address without an Eircode is left as heard', () => {
  assert.equal(voiceToAddress('26 Shanecastle Grove Clondalkin Dublin 22'), '26 Shanecastle Grove Clondalkin Dublin 22');
  assert.equal(voiceToAddress('12 Library Hall Tullamore'), '12 Library Hall Tullamore');
  assert.equal(voiceToAddress('Apt 4 26 Main St'), 'Apt 4 26 Main St');
  assert.equal(voiceToAddress(''), '');
});
