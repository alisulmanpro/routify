import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containFit, photoLines, pickAddress } from '../src/lib/scan/photoLines';

const line = (lineText: string, cx: number, cy: number, width = 400, height = 40) => ({ lineText, lineFrame: { boundingCenterX: cx, boundingCenterY: cy, width, height } });

// A page with the client's four addresses, one per line, read in two blocks and out of order.
const PAGE = {
  blocks: [
    { lines: [line('26 shanecastle grove clondalkin dublin 22', 300, 300), line('22shanecasgle cre dublin 22', 300, 400)] },
    { lines: [line('26 Shanecastle dr clondalkin dublin 22', 300, 100), line('26 shanecastle cl clondalkin dublin 22', 300, 200), line('.', 300, 500, 10, 10)] },
  ],
};

test('lines come in reading order, noise dropped, boxes from the centre and size', () => {
  const lines = photoLines(PAGE);
  assert.deepEqual(lines.map((l) => l.text), [
    '26 Shanecastle dr clondalkin dublin 22', '26 shanecastle cl clondalkin dublin 22',
    '26 shanecastle grove clondalkin dublin 22', '22shanecasgle cre dublin 22',
  ]);
  assert.deepEqual(lines[0].box, { left: 100, top: 80, width: 400, height: 40 });
});

test('lines on the same row are read left to right', () => {
  const lines = photoLines({ blocks: [{ lines: [line('Dublin 22', 600, 102, 200), line('26 Main St', 200, 100, 200)] }] });
  assert.deepEqual(lines.map((l) => l.text), ['26 Main St', 'Dublin 22']);
});

test('one tapped line out of a page of addresses gives that address only, cleaned', () => {
  const lines = photoLines(PAGE);
  assert.deepEqual(pickAddress(lines, new Set([lines[3].id])), { kind: 'address', text: '22 shanecasgle cre dublin 22' });
  assert.equal(pickAddress(lines, new Set()), null);
});

test('several lines of one label are joined in reading order, whatever order they were tapped', () => {
  const label = photoLines({ blocks: [{ lines: [line('Clondalkin', 300, 150), line('26 Shanecastle Grove', 300, 100), line('Dublin 22', 300, 200)] }] });
  assert.deepEqual(pickAddress(label, new Set(['2', '0', '1'])), { kind: 'address', text: '26 Shanecastle Grove, Clondalkin, Dublin 22' });
});

test('an Eircode in the chosen lines wins; two different ones do not', () => {
  const label = photoLines({ blocks: [{ lines: [line('26 Shanecastle Grove', 300, 100), line('Dublin 22 D22 Y2F4', 300, 150), line('D15 DK4A', 300, 200)] }] });
  assert.deepEqual(pickAddress(label, new Set(['0', '1'])), { kind: 'eircode', eircode: 'D22 Y2F4', text: '26 Shanecastle Grove, Dublin 22 D22 Y2F4' });
  assert.equal(pickAddress(label, new Set(['1', '2']))?.kind, 'address');
});

test('contain fit: the photo is centred and scaled to fit the view', () => {
  assert.deepEqual(containFit({ width: 1440, height: 1920 }, { width: 360, height: 640 }), { scale: 0.25, left: 0, top: 80 });
  assert.deepEqual(containFit({ width: 1920, height: 1440 }, { width: 360, height: 640 }), { scale: 0.1875, left: 0, top: 185 });
});
