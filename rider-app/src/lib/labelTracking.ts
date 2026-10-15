// Geometry for the camera's guide box: where the label is on screen, and how to keep the box on it
// as the camera moves.
import type { TextBlock, TextBlockFrame } from './optionalNative';

export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { width: number; height: number };

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const contains = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Grows a rect by a fraction of its size on every side, kept inside the view. */
export function grow(r: Rect, fraction: number, view?: Size): Rect {
  const dx = r.w * fraction;
  const dy = r.h * fraction;
  const out = { x: r.x - dx, y: r.y - dy, w: r.w + dx * 2, h: r.h + dy * 2 };
  if (!view) return out;
  const x = Math.max(0, out.x);
  const y = Math.max(0, out.y);
  return { x, y, w: Math.min(view.width, out.x + out.w) - x, h: Math.min(view.height, out.y + out.h) - y };
}

/**
 * Maps photo pixels to preview points. The preview fills the view like `cover`, so the photo is
 * scaled to cover it and cropped equally on both sides.
 */
export function photoToView(photo: Size, view: Size) {
  const scale = Math.max(view.width / photo.width, view.height / photo.height);
  const offsetX = (view.width - photo.width * scale) / 2;
  const offsetY = (view.height - photo.height * scale) / 2;
  return (f: TextBlockFrame): Rect => ({ x: f.left * scale + offsetX, y: f.top * scale + offsetY, w: f.width * scale, h: f.height * scale });
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The label's outline on screen. With an address read, it is the text blocks that hold the address
 * (and name / parcel ID), plus the blocks and barcode right next to them; without one, the biggest
 * cluster of text.
 */
export function labelRect(blocks: TextBlock[], map: (f: TextBlockFrame) => Rect, view: Size, used: string[], barcode: Rect | null): Rect | null {
  const placed = blocks.filter((b) => b.frame).map((b) => ({ block: b, rect: map(b.frame!) }));
  if (!placed.length) return barcode ? grow(barcode, 0.35, view) : null;

  const wanted = used.map(normalize).filter((t) => t.length >= 3);
  const matches = wanted.length
    ? placed.filter(({ block }) => block.lines.some((l) => { const t = normalize(l.text); return t.length >= 3 && wanted.some((w) => w.includes(t) || t.includes(w)); }))
    : [];
  const seed = matches.length ? matches : [placed.reduce((a, b) => (b.rect.w * b.rect.h > a.rect.w * a.rect.h ? b : a))];

  // Pull in neighbouring blocks (sender line, "an post", the parcel ID under the barcode, …).
  let area = union(seed.map((m) => m.rect))!;
  const near = grow(area, 0.4);
  const neighbours = placed.filter((p) => contains(near, center(p.rect))).map((p) => p.rect);
  if (barcode && contains(grow(area, 0.6), center(barcode))) neighbours.push(barcode);
  area = union([area, ...neighbours])!;
  return grow(area, 0.06, view);
}

export type Point = { x: number; y: number };
/** The guide box as four corners (clockwise from top-left), so it can sit on a tilted sticker. */
export type Quad = [Point, Point, Point, Point];

export const rectToQuad = (r: Rect): Quad => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
export const quadBounds = (q: Quad): Rect => union(q.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;

/** Same as photoToView, for single points. */
export function pointToView(photo: Size, view: Size) {
  const map = photoToView(photo, view);
  return (p: Point): Point => { const r = map({ left: p.x, top: p.y, width: 0, height: 0 }); return { x: r.x, y: r.y }; };
}

/** Moves and scales the box with the barcode, which the camera reports many times a second. */
export function followBarcode(box: Quad, anchor: Rect, now: Rect): Quad {
  const scale = Math.min(2, Math.max(0.5, Math.sqrt((now.w * now.h) / Math.max(1, anchor.w * anchor.h))));
  const a = center(anchor);
  const n = center(now);
  return box.map((p) => ({ x: n.x + (p.x - a.x) * scale, y: n.y + (p.y - a.y) * scale })) as Quad;
}

/**
 * A box round the label's text that turns with it (ML Kit gives each line's four corners), for when
 * no sticker edge is found. `area` picks the text blocks (same units as the blocks); `angleDeg` is the
 * text's tilt. Corners are clockwise from the label's own top-left.
 */
export function textQuad(blocks: TextBlock[], area: Rect, angleDeg: number, margin = 0.06): Quad | null {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const pts: Point[] = [];
  for (const b of blocks) {
    if (!b.frame || !contains(area, { x: b.frame.left + b.frame.width / 2, y: b.frame.top + b.frame.height / 2 })) continue;
    for (const l of b.lines) {
      const f = l.frame ?? b.frame;
      pts.push(...(l.corners?.length === 4 ? l.corners : rectToQuad({ x: f.left, y: f.top, w: f.width, h: f.height })));
    }
  }
  if (!pts.length) return null;
  // Into the text's own axes, a level box there, then back.
  const turned = pts.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  const box = grow(union(turned.map((p) => ({ ...p, w: 0, h: 0 })))!, margin);
  return rectToQuad(box).map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos })) as Quad;
}

/** The guide box's shape on screen, picked to match the label in view. */
export type LabelShape = 'wide' | 'square' | 'tall';
/** Height / width of each guide shape. */
export const SHAPE_ASPECT: Record<LabelShape, number> = { wide: 0.72, square: 1, tall: 1.4 };

/** Whether a detected label looks wide, square or tall on screen (by its edges, so tilt doesn't stretch it). */
export function quadShape(q: Quad): LabelShape {
  const len = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const across = (len(q[0], q[1]) + len(q[3], q[2])) / 2;
  const down = (len(q[0], q[3]) + len(q[1], q[2])) / 2;
  // A label turned on its side has its own top edge running up the screen.
  const sideways = Math.abs(q[1].y - q[0].y) > Math.abs(q[1].x - q[0].x);
  const ratio = (sideways ? across : down) / Math.max(1, sideways ? down : across);
  return ratio < 0.82 ? 'wide' : ratio > 1.22 ? 'tall' : 'square';
}

// The guide window leaves room for messages above and the controls below.
const WINDOW_MAX_WIDTH = 420;
const WINDOW_SIDE_GAP = 24;
const WINDOW_MAX_HEIGHT_SHARE = 0.48;

/** The fixed guide window, centred in the view, for a shape's aspect (height / width). */
export function scanWindow(view: Size, aspect: number): Rect {
  const w = Math.max(0, Math.min(view.width - WINDOW_SIDE_GAP * 2, WINDOW_MAX_WIDTH, (view.height * WINDOW_MAX_HEIGHT_SHARE) / aspect));
  const h = w * aspect;
  return { x: (view.width - w) / 2, y: (view.height - h) / 2, w, h };
}

/**
 * The label sits in the guide window: most of it (`minInside` of points spread over the label) is
 * inside the window, with a little slack, and it is big enough to read (its area at least `minFill`
 * of the window's). Corners may stick out, so a tilted or turned label still counts.
 */
export function fitsWindow(q: Quad, win: Rect, slack = 0.08, minFill = 0.2, minInside = 0.85) {
  const outer = grow(win, slack);
  const steps = 6;
  let inside = 0, total = 0;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const u = i / steps, v = j / steps;
      const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
      const bottom = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
      total += 1;
      if (contains(outer, { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v })) inside += 1;
    }
  }
  const area = Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;
  return inside / total >= minInside && area >= win.w * win.h * minFill;
}

/**
 * The label's text area with its perspective, from ML Kit's line corners, for straightening a label
 * whose paper edge can't be found. Works in the text's own axes (`angleDeg`, u along the lines, v
 * down): the top and bottom edges follow the first and last lines (their slant shows a label turned
 * away to one side), and the left edge follows where the lines start (address lines are
 * left-aligned; they draw together when the label leans back). The right edge mirrors the left,
 * as it does when the label is in the middle of the picture. Null when there are too few lines or
 * the result looks wrong; the caller then uses the turned box (`textQuad`).
 */
export function perspectiveTextQuad(blocks: TextBlock[], area: Rect, angleDeg: number, margin = 0.06): Quad | null {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const toText = (p: Point) => ({ u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos });
  const fromText = (u: number, v: number): Point => ({ x: u * cos - v * sin, y: u * sin + v * cos });

  const lines: { u: number; v: number }[][] = [];
  for (const b of blocks) {
    if (!b.frame || !contains(area, { x: b.frame.left + b.frame.width / 2, y: b.frame.top + b.frame.height / 2 })) continue;
    for (const l of b.lines) if (l.corners?.length === 4 && l.text.trim().length >= 2) lines.push(l.corners.map(toText));
  }
  if (lines.length < 3) return null;
  const pts = lines.flat();
  const mid = (l: { v: number }[]) => l.reduce((s, p) => s + p.v, 0) / 4;
  const top = lines.reduce((x, l) => (mid(l) < mid(x) ? l : x));
  const bottom = lines.reduce((x, l) => (mid(l) > mid(x) ? l : x));

  // An edge as v = v0 + slope * u, moved out until every corner is on the inner side.
  const edge = (p: { u: number; v: number }, q: { u: number; v: number }, below: boolean) => {
    const slope = (q.v - p.v) / Math.max(1e-6, q.u - p.u);
    const offsets = pts.map((t) => t.v - slope * t.u);
    return { slope, v0: below ? Math.max(...offsets) : Math.min(...offsets) };
  };
  const topEdge = edge(top[0], top[1], false);
  const bottomEdge = edge(bottom[3], bottom[2], true);
  const height = Math.max(1, bottomEdge.v0 - topEdge.v0);

  // Left edge as u = u0 + lean * v, fitted to the start of the lines that start furthest left
  // (indented or right-hand text is left out), then moved out to enclose everything.
  const starts = lines.map((l) => ({ u: (l[0].u + l[3].u) / 2, v: (l[0].v + l[3].v) / 2 }));
  const width = Math.max(1, Math.max(...pts.map((p) => p.u)) - Math.min(...pts.map((p) => p.u)));
  let lean = 0;
  let aligned = starts;
  for (let round = 0; round < 3; round += 1) {
    if (aligned.length < 3) break;
    const mv = aligned.reduce((s, p) => s + p.v, 0) / aligned.length;
    const mu = aligned.reduce((s, p) => s + p.u, 0) / aligned.length;
    const den = aligned.reduce((s, p) => s + (p.v - mv) ** 2, 0);
    if (den < (height * 0.3) ** 2) break;
    lean = aligned.reduce((s, p) => s + (p.v - mv) * (p.u - mu), 0) / den;
    // Keep the starts on the fitted edge for the next round; indented ones drop out.
    aligned = starts.filter((t) => Math.abs(t.u - mu - lean * (t.v - mv)) < width * 0.04);
  }
  if (Math.abs(lean) > 0.35 || Math.abs(topEdge.slope) > 0.35 || Math.abs(bottomEdge.slope) > 0.35) return null;
  const left = Math.min(...pts.map((p) => p.u - lean * p.v));
  const right = Math.max(...pts.map((p) => p.u + lean * p.v));

  // Corners where the edges meet, pushed out by the margin.
  const dv = height * margin, du = width * margin;
  const meet = (u0: number, l: number, e: { slope: number; v0: number }, out: number) => {
    // u = u0 + l * v and v = v0 + slope * u.
    const v = (e.v0 + out + e.slope * u0) / (1 - e.slope * l);
    return { u: u0 + l * v, v };
  };
  const corners = [
    meet(left - du, lean, topEdge, -dv), meet(right + du, -lean, topEdge, -dv),
    meet(right + du, -lean, bottomEdge, dv), meet(left - du, lean, bottomEdge, dv),
  ];
  const quad = corners.map((c) => fromText(c.u, c.v)) as Quad;
  // A sane label: each pair of opposite edges within 2x of each other.
  const len = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  const ratio = (x: number, y: number) => Math.max(x, y) / Math.max(1e-6, Math.min(x, y));
  if (ratio(len(quad[0], quad[1]), len(quad[3], quad[2])) > 2 || ratio(len(quad[0], quad[3]), len(quad[1], quad[2])) > 2) return null;
  return quad;
}

/** How far a box moved from `a` to `b`: the corners' average shift, as a share of its size (0 = still). */
export function movement(a: Quad, b: Quad) {
  const bounds = quadBounds(a);
  const size = Math.max(1, Math.hypot(bounds.w, bounds.h));
  return a.reduce((sum, p, i) => sum + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0) / 4 / size;
}

/** A label held still for auto-capture: since when, where it settled, and frames missed since. */
export type Stability = { since: number; box: Quad | null; misses: number };
// How far the label may drift from where it settled (share of its size) and still count as still,
// so normal hand shake doesn't restart the timer.
export const MOVE_TOLERANCE = 0.1;
// Frames in a row that may miss the label (OCR lost a line, one blurry photo) before it restarts.
export const MISS_GRACE = 1;

/**
 * One scan frame's step of the auto-capture timer. `ok`: the label is readable and in the box this
 * frame. Drift is measured from where the label settled, not from the last frame, so small shakes
 * never add up to a restart; a single bad frame is forgiven.
 */
export function stepStability(st: Stability | null, ok: boolean, box: Quad | null, now: number): Stability | null {
  if (ok) {
    if (!st || (st.box && box && movement(st.box, box) > MOVE_TOLERANCE)) return { since: now, box, misses: 0 };
    return { ...st, box: st.box ?? box, misses: 0 };
  }
  if (st && st.misses < MISS_GRACE) return { ...st, misses: st.misses + 1 };
  return null;
}

/**
 * The camera picture size to use (from getAvailablePictureSizesAsync, "WIDTHxHEIGHT"): full-sensor
 * photos (12 MP and more) make every scan and OCR pass slow, while labels read fine at ~1600 px.
 * Picks the size whose long side is closest to `target` within [minSide, maxSide], keeping the
 * aspect of the largest size (the camera's default), so the preview isn't reframed. Null to leave
 * the default (no usable sizes, e.g. iOS presets only).
 */
export function pickPictureSize(sizes: string[], target = 1600, minSide = 1200, maxSide = 2100): string | null {
  const parsed = sizes
    .map((s) => { const m = s.match(/^(\d+)x(\d+)$/); return m ? { s, w: +m[1], h: +m[2] } : null; })
    .filter((x): x is { s: string; w: number; h: number } => !!x && x.w > 0 && x.h > 0);
  if (!parsed.length) return null;
  const aspect = (x: { w: number; h: number }) => Math.max(x.w, x.h) / Math.min(x.w, x.h);
  const largest = parsed.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const fits = parsed.filter((x) => Math.abs(aspect(x) - aspect(largest)) < 0.03 && Math.max(x.w, x.h) >= minSide && Math.max(x.w, x.h) <= maxSide);
  if (!fits.length) return null;
  return fits.reduce((a, b) => (Math.abs(Math.max(b.w, b.h) - target) < Math.abs(Math.max(a.w, a.h) - target) ? b : a)).s;
}

/**
 * The label is already flat and level (text within `maxAngle` degrees, opposite edges about the
 * same length), so straightening would change nothing worth its cost.
 */
export function isStraight(q: Quad, angleDeg: number, maxAngle = 5, maxSkew = 0.08) {
  if (Math.abs(angleDeg) >= maxAngle) return false;
  const len = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const off = (x: number, y: number) => Math.abs(x - y) / Math.max(1e-6, Math.max(x, y));
  return off(len(q[0], q[1]), len(q[3], q[2])) <= maxSkew && off(len(q[0], q[3]), len(q[1], q[2])) <= maxSkew;
}
