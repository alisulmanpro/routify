import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEircodeVote } from '../src/lib/scan/eircodeVote';

test('locks only when the same code is in 3 of the last 5 frames', () => {
  const vote = createEircodeVote();
  assert.equal(vote.push(['R93 Y201']).kind, 'none');
  assert.equal(vote.push([]).kind, 'none');
  assert.equal(vote.push(['R93 Y201']).kind, 'none');
  assert.deepEqual(vote.push(['R93 Y201']), { kind: 'locked', eircode: 'R93 Y201' });
});

test('a misread in between does not win, and old frames fall out of the window', () => {
  const vote = createEircodeVote();
  vote.push(['R93 Y201']);
  vote.push(['R93 Y2D1']);
  vote.push([]);
  vote.push([]);
  vote.push([]);
  assert.equal(vote.push(['R93 Y201']).kind, 'none', 'the first read is now 5 frames old');
  vote.push(['R93 Y2D1']);
  assert.deepEqual(vote.push(['R93 Y201']), { kind: 'none' });
  assert.deepEqual(vote.push(['R93 Y201']), { kind: 'locked', eircode: 'R93 Y201' });
});

test('two steady codes in view are ambiguous, not locked', () => {
  const vote = createEircodeVote();
  for (let i = 0; i < 2; i += 1) vote.push(['D18 K2P1', 'V95 V28P']);
  assert.deepEqual(vote.push(['V95 V28P', 'D18 K2P1']), { kind: 'ambiguous', eircodes: ['D18 K2P1', 'V95 V28P'] });
});

test('reset starts again', () => {
  const vote = createEircodeVote();
  vote.push(['R93 Y201']);
  vote.push(['R93 Y201']);
  vote.reset();
  assert.equal(vote.push(['R93 Y201']).kind, 'none');
});
