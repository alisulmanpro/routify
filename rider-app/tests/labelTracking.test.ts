import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_ASPECT, fitsWindow, isStraight, perspectiveTextQuad, pickPictureSize, stepStability, quadShape, rectToQuad, scanWindow, textQuad, type Quad } from '../src/lib/labelTracking';
import type { TextBlock } from '../src/lib/optionalNative';

// A text line `w` x `h` centred at (cx, cy), turned by `deg`, as ML Kit reports it.
function line(cx: number, cy: number, w: number, h: number, deg: number) {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ x: cx + (sx * w / 2) * cos - (sy * h / 2) * sin, y: cy + (sx * w / 2) * sin + (sy * h / 2) * cos }));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const frame = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  return { text: 'LINE', frame, corners };
}

test('the fallback box turns with tilted text instead of staying level', () => {
  const deg = 30, rad = (deg * Math.PI) / 180;
  // Three lines stacked along the label's own vertical axis.
  const lines = [-20, 0, 20].map((d) => line(200 - d * Math.sin(rad), 300 + d * Math.cos(rad), 120, 10, deg));
  const blocks: TextBlock[] = [{ text: 'x', frame: { left: 0, top: 0, width: 400, height: 600 }, lines }];
  const q = textQuad(blocks, { x: 0, y: 0, w: 400, h: 600 }, deg, 0)!;
  const topEdge = (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI;
  assert.ok(Math.abs(topEdge - deg) < 0.5, `top edge at ${topEdge.toFixed(1)}°`);
  assert.ok(Math.abs(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) - 120) < 1, 'width is the line length, not the level bounding box');
  assert.ok(Math.abs(Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) - 50) < 1, 'height spans the three lines');
});

test('the fallback box only uses blocks inside the chosen area', () => {
  const blocks: TextBlock[] = [
    { text: 'a', frame: { left: 90, top: 95, width: 20, height: 10 }, lines: [line(100, 100, 20, 10, 0)] },
    { text: 'b', frame: { left: 490, top: 495, width: 20, height: 10 }, lines: [line(500, 500, 20, 10, 0)] },
  ];
  const q = textQuad(blocks, { x: 0, y: 0, w: 200, h: 200 }, 0, 0)!;
  assert.deepEqual(q.map((p) => [Math.round(p.x), Math.round(p.y)]), [[90, 95], [110, 95], [110, 105], [90, 105]]);
});

test('the guide shape follows the label, even turned on its side', () => {
  assert.equal(quadShape(rectToQuad({ x: 0, y: 0, w: 300, h: 200 })), 'wide');
  assert.equal(quadShape(rectToQuad({ x: 0, y: 0, w: 200, h: 210 })), 'square');
  assert.equal(quadShape(rectToQuad({ x: 0, y: 0, w: 200, h: 320 })), 'tall');
  // A wide label turned 90°: its top edge runs down the screen, so it looks tall.
  const sideways: Quad = [{ x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }, { x: 0, y: 0 }];
  assert.equal(quadShape(sideways), 'tall');
});

test('the guide window keeps its aspect and fits the screen', () => {
  const view = { width: 390, height: 800 };
  for (const shape of ['wide', 'square', 'tall'] as const) {
    const win = scanWindow(view, SHAPE_ASPECT[shape]);
    assert.ok(Math.abs(win.h / win.w - SHAPE_ASPECT[shape]) < 1e-9);
    assert.ok(win.x >= 24 && win.x + win.w <= 366 && win.h <= 800 * 0.48 + 1e-9);
  }
});

test('a label fits the window only when inside it and big enough', () => {
  const win = { x: 100, y: 100, w: 200, h: 200 };
  assert.ok(fitsWindow(rectToQuad({ x: 110, y: 110, w: 180, h: 170 }), win));
  // Slightly over the edge is fine; half outside is not.
  assert.ok(fitsWindow(rectToQuad({ x: 90, y: 95, w: 215, h: 200 }), win));
  assert.ok(!fitsWindow(rectToQuad({ x: 200, y: 100, w: 200, h: 200 }), win));
  // Far away: too small to read.
  assert.ok(!fitsWindow(rectToQuad({ x: 180, y: 180, w: 40, h: 40 }), win));
  // A label turned 25° in the middle of the window: its corners stick out, but it counts.
  const a = (25 * Math.PI) / 180;
  const turned = rectToQuad({ x: -85, y: -80, w: 170, h: 160 }).map((p) => ({ x: 200 + p.x * Math.cos(a) - p.y * Math.sin(a), y: 200 + p.x * Math.sin(a) + p.y * Math.cos(a) })) as Quad;
  assert.ok(!turned.every((p) => p.x >= 100 && p.x <= 300 && p.y >= 100 && p.y <= 300), 'corners outside');
  assert.ok(fitsWindow(turned, win));
});

// A keystone view of a flat label: the label leans back (top shrinks) and is turned 8°.
function project(p: { x: number; y: number }) {
  const w = 1 + 0.0012 * p.y; // farther away at the top
  const x = 300 + (p.x - 200) / w, y = 100 + p.y / w;
  const a = (8 * Math.PI) / 180;
  return { x: 300 + (x - 300) * Math.cos(a) - (y - 300) * Math.sin(a), y: 300 + (x - 300) * Math.sin(a) + (y - 300) * Math.cos(a) };
}
function projectedLabel(texts: { text: string; x: number; y: number; w: number }[]): TextBlock[] {
  const lines = texts.map((t) => {
    const corners = [[t.x, t.y], [t.x + t.w, t.y], [t.x + t.w, t.y + 24], [t.x, t.y + 24]].map(([x, y]) => project({ x, y }));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    return { text: t.text, frame: { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, corners };
  });
  return [{ text: 'label', frame: { left: 0, top: 0, width: 800, height: 800 }, lines }];
}

test('the text outline follows the label perspective, not just its tilt', () => {
  const texts = [
    { text: 'TO: EOIN DOHERTY', x: 40, y: 40, w: 300 },
    { text: '155 HILLCREST CLOSE', x: 40, y: 90, w: 340 },
    { text: 'DROGHEDA', x: 40, y: 140, w: 180 },
    { text: 'CO. LOUTH', x: 40, y: 190, w: 170 },
    { text: 'A92 EDWE', x: 40, y: 240, w: 200 },
    { text: 'IRELAND', x: 40, y: 290, w: 150 },
  ];
  const blocks = projectedLabel(texts);
  const q = perspectiveTextQuad(blocks, { x: 0, y: 0, w: 800, h: 800 }, 8, 0)!;
  assert.ok(q, 'found');
  // The true text area's corners, as the camera sees them.
  const truth = [project({ x: 40, y: 40 }), project({ x: 380, y: 40 }), project({ x: 380, y: 314 }), project({ x: 40, y: 314 })];
  // Left corners and the top / bottom edges are matched closely; the right edge only approximately
  // (it is mirrored, and the right ends of the lines are ragged).
  for (const i of [0, 3]) assert.ok(Math.hypot(q[i].x - truth[i].x, q[i].y - truth[i].y) < 8, `corner ${i}: ${JSON.stringify(q[i])} vs ${JSON.stringify(truth[i])}`);
  for (const i of [1, 2]) assert.ok(Math.hypot(q[i].x - truth[i].x, q[i].y - truth[i].y) < 25, `corner ${i}: ${JSON.stringify(q[i])} vs ${JSON.stringify(truth[i])}`);
  // The plain turned box misses the perspective by much more at the top-left.
  const flat = textQuad(blocks, { x: 0, y: 0, w: 800, h: 800 }, 8, 0)!;
  assert.ok(Math.hypot(flat[0].x - truth[0].x, flat[0].y - truth[0].y) > Math.hypot(q[0].x - truth[0].x, q[0].y - truth[0].y));
});

test('an indented address block under the TO line still gives the perspective', () => {
  const texts = [
    { text: 'TO: EOIN DOHERTY', x: 20, y: 40, w: 300 },
    { text: '155 HILLCREST CLOSE', x: 60, y: 90, w: 320 },
    { text: 'DROGHEDA', x: 60, y: 140, w: 180 },
    { text: 'CO. LOUTH', x: 60, y: 190, w: 170 },
    { text: 'A92 EDWE', x: 60, y: 240, w: 200 },
    { text: 'IRELAND', x: 60, y: 290, w: 150 },
  ];
  const q = perspectiveTextQuad(projectedLabel(texts), { x: 0, y: 0, w: 800, h: 800 }, 8, 0)!;
  // The left edge leans with the address lines; the TO line only pushes it out a little.
  const truth = [project({ x: 20, y: 40 }), project({ x: 20, y: 314 })];
  assert.ok(Math.hypot(q[0].x - truth[0].x, q[0].y - truth[0].y) < 12, JSON.stringify([q[0], truth[0]]));
  assert.ok(Math.hypot(q[3].x - truth[1].x, q[3].y - truth[1].y) < 12, JSON.stringify([q[3], truth[1]]));
});

test('too few lines: no perspective guess', () => {
  const blocks = projectedLabel([{ text: 'A92 EDWE', x: 40, y: 40, w: 200 }, { text: 'IRELAND', x: 40, y: 90, w: 150 }]);
  assert.equal(perspectiveTextQuad(blocks, { x: 0, y: 0, w: 800, h: 800 }, 8), null);
});

test('auto-capture timer: hand shake and one bad frame keep it running, real movement restarts it', () => {
  const at = (dx: number): Quad => rectToQuad({ x: 100 + dx, y: 100, w: 200, h: 150 });
  let st = stepStability(null, true, at(0), 0);
  // Shaking a few pixels each way for a second: still the same start time.
  for (const [t, dx] of [[300, 6], [600, -5], [900, 7]] as const) st = stepStability(st, true, at(dx), t);
  assert.equal(st?.since, 0);
  // One frame where OCR missed the address: forgiven.
  st = stepStability(st, false, null, 1200);
  assert.equal(st?.since, 0);
  st = stepStability(st, true, at(0), 1500);
  assert.equal(st?.since, 0);
  assert.equal(st?.misses, 0);
  // Two bad frames in a row: restart.
  assert.equal(stepStability(stepStability(st, false, null, 1800), false, null, 2100), null);
  // Moved to a new spot: the timer restarts there.
  assert.equal(stepStability(st, true, at(60), 1800)?.since, 1800);
});

test('picture size: about 1600 px, same aspect as the camera default', () => {
  const sizes = ['4000x3000', '3264x2448', '1920x1080', '1600x1200', '1280x960', '640x480'];
  assert.equal(pickPictureSize(sizes), '1600x1200');
  assert.equal(pickPictureSize(['4000x3000', '1920x1080', '640x480']), null);
  assert.equal(pickPictureSize(['Photo', 'High']), null);
});

test('straight labels skip the warp; turned or keystoned ones do not', () => {
  const flat = rectToQuad({ x: 0, y: 0, w: 400, h: 300 });
  assert.ok(isStraight(flat, 2));
  assert.ok(!isStraight(flat, 9));
  const keystone: Quad = [{ x: 40, y: 0 }, { x: 360, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
  assert.ok(!isStraight(keystone, 0));
});
