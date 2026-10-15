import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64, encodeGrayBmp, orientQuad, plausibleSticker, squareToQuad, straighten, stretchContrast, warpSize } from '../src/lib/labelWarp';
import type { Quad } from '../src/lib/labelTracking';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('the square maps onto the quad corners, also under perspective', () => {
  const q: Quad = [{ x: 30, y: 20 }, { x: 410, y: 60 }, { x: 380, y: 300 }, { x: 10, y: 260 }];
  const map = squareToQuad(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = map(u, v);
    assert.ok(close(p.x, q[i].x) && close(p.y, q[i].y), `corner ${i}`);
  });
});

test('the corner order follows the text, so a sideways label comes out upright', () => {
  const q: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  assert.deepEqual(orientQuad(q, 2), q);
  // Text running down the screen (label turned 90° clockwise): the top-right corner is the label's top-left.
  assert.deepEqual(orientQuad(q, 90)[0], { x: 100, y: 0 });
});

test('output size keeps the label proportions within the size limits', () => {
  const s = warpSize([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], 900, 1400);
  assert.deepEqual(s, { width: 900, height: 675 });
  assert.equal(warpSize([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 1000 }, { x: 0, y: 1000 }], 900, 1400).width, 1400);
});

test('a tilted dark bar is straightened back to a level bar', () => {
  // 200x200 white image with a 100x20 black bar turned 30° about the centre.
  const W = 200, H = 200, data = new Uint8Array(W * H * 4).fill(255);
  const a = (30 * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const dx = x + 0.5 - 100, dy = y + 0.5 - 100;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    if (Math.abs(u) < 50 && Math.abs(v) < 10) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  }
  // The label: an 160x80 rectangle around the bar, turned the same way.
  const corner = (u: number, v: number) => ({ x: 100 + u * cos - v * sin, y: 100 + u * sin + v * cos });
  const q: Quad = [corner(-80, -40), corner(80, -40), corner(80, 40), corner(-80, 40)];
  const out = straighten({ width: W, height: H, data }, q, { width: 160, height: 80 });
  const at = (x: number, y: number) => out.data[y * out.width + x];
  assert.ok(at(80, 40) < 40, 'bar centre is dark');
  assert.ok(at(35, 40) < 60 && at(125, 40) < 60, 'bar ends are dark on the same row');
  assert.ok(at(80, 20) > 200 && at(80, 60) > 200, 'above and below the bar is paper');
});

test('contrast stretch makes faded print black and grey paper white', () => {
  const data = new Uint8Array(1000);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 10 === 0 ? 120 : 200;
  const out = stretchContrast({ width: 1000, height: 1, data });
  assert.equal(out.data[0], 0);
  assert.equal(out.data[1], 255);
});

test('BMP encoding: header, palette and bottom-up rows', () => {
  const img = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
  const bmp = encodeGrayBmp(img);
  const view = new DataView(bmp.buffer);
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), 'BM');
  assert.equal(view.getUint32(2, true), bmp.length);
  assert.equal(view.getUint16(28, true), 8);
  const offset = view.getUint32(10, true);
  // Rows are padded to 4 bytes and stored bottom row first.
  assert.deepEqual([...bmp.subarray(offset, offset + 8)], [4, 5, 6, 0, 1, 2, 3, 0]);
});

test('base64 matches Node for every padding length', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 40000]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('a sticker outline that ran into the background is not used for the warp', () => {
  const label: Quad = [{ x: 100, y: 100 }, { x: 400, y: 120 }, { x: 390, y: 300 }, { x: 90, y: 280 }];
  const text = { x: 130, y: 140, w: 180, h: 110 };
  assert.ok(plausibleSticker(label, text));
  const background: Quad = [{ x: 0, y: 0 }, { x: 1600, y: 0 }, { x: 1600, y: 1200 }, { x: 0, y: 1200 }];
  assert.ok(!plausibleSticker(background, text), 'far bigger than the text');
  assert.ok(!plausibleSticker(label, { x: 600, y: 600, w: 50, h: 20 }), 'text outside the outline');
});
