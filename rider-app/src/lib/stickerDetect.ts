// Finds the paper sticker on a carton in a photo: the light, low-colour region around the label text.
// Brown cardboard is darker and more saturated than label paper, so the sticker stands out even when
// it is turned at an angle. The result is a rotated rectangle in photo pixels.
import { requireOptionalNativeModule } from 'expo';
import { decode } from 'jpeg-js';
import type { Point, Quad, Rect, Size } from './labelTracking';
import { bytesToBase64, encodeGrayBmp, expandQuad, orientQuad, straighten, warpSize } from './labelWarp';

// Small enough to process in a few milliseconds, big enough to see the sticker's edges.
const WORK_WIDTH = 160;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Uint8Array(128);
for (let i = 0; i < B64.length; i += 1) B64_INDEX[B64.charCodeAt(i)] = i;

function base64ToBytes(b64: string) {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64_INDEX[clean.charCodeAt(i)] << 18) | (B64_INDEX[clean.charCodeAt(i + 1)] << 12)
      | ((B64_INDEX[clean.charCodeAt(i + 2)] || 0) << 6) | (B64_INDEX[clean.charCodeAt(i + 3)] || 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// The image manipulator is native; builds made before it was added simply skip sticker detection.
export const hasStickerDetection = !!requireOptionalNativeModule('ExpoImageManipulator');

async function smallPixels(uri: string) {
  if (!hasStickerDetection) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so older builds don't crash on startup
  const { ImageManipulator, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(uri).resize({ width: WORK_WIDTH });
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
    if (!saved.base64) return null;
    return decode(base64ToBytes(saved.base64), { useTArray: true, formatAsRGBA: true });
  } finally {
    image.release();
    context.release();
  }
}

export type Clarity = {
  /** Edge strength in the text area relative to the paper's brightness; low means blurry. */
  sharpness: number;
  /** Brightness (0-255) of the label paper; low means too dark to read. */
  brightness: number;
};
export type LabelAnalysis = { sticker: Quad | null; clarity: Clarity | null };

// Calibrated on test photos: sharp label ≈ 0.08, slightly blurred ≈ 0.012, very blurred ≈ 0.001.
export const MIN_SHARPNESS = 0.015;
export const MIN_BRIGHTNESS = 110;

/**
 * The sticker around `text` (the label text, in photo pixels) and how readable the photo is.
 * `sticker` is null when no clear sticker is found (e.g. a white label on a white background).
 */
export async function analyzeLabel(uri: string, photo: Size, text: Rect): Promise<LabelAnalysis> {
  const img = await smallPixels(uri);
  if (!img) return { sticker: null, clarity: null };
  return { sticker: stickerFromPixels(img, photo, text), clarity: clarityFromPixels(img, photo, text) };
}

/** Sharpness (variance of the Laplacian) and paper brightness inside the text area. */
export function clarityFromPixels(img: { width: number; height: number; data: Uint8Array }, photo: Size, text: Rect): Clarity | null {
  const { width: W, height: H, data } = img;
  const k = W / photo.width;
  const x0 = Math.max(1, Math.floor(text.x * k)), x1 = Math.min(W - 1, Math.ceil((text.x + text.w) * k));
  const y0 = Math.max(1, Math.floor(text.y * k)), y1 = Math.min(H - 1, Math.ceil((text.y + text.h) * k));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const g = (x: number, y: number) => { const i = (y * W + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
  let sum = 0, sum2 = 0, n = 0;
  const light: number[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const lap = 4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1);
      sum += lap; sum2 += lap * lap; n += 1;
      light.push(g(x, y));
    }
  }
  light.sort((a, b) => a - b);
  const brightness = light[Math.floor(light.length * 0.8)];
  const variance = sum2 / n - (sum / n) ** 2;
  return { sharpness: variance / Math.max(1, brightness * brightness), brightness };
}

/**
 * Crops the photo to the sticker and turns it upright, so OCR reads only the label and in the
 * right direction. Full perspective correction isn't available without a native warp, so a
 * strongly angled label is straightened by rotation only. `textAngle` is the text's tilt in degrees
 * (from the OCR lines, which is more reliable than guessing which sticker corner is "top-left").
 * Returns the new image's URI (caller deletes it).
 */
export async function cropLabel(uri: string, photo: Size, quad: Quad, textAngle: number): Promise<string | null> {
  if (!hasStickerDetection) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so older builds don't crash on startup
  const { ImageManipulator, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const margin = 0.04 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const originX = Math.max(0, Math.floor(Math.min(...xs) - margin));
  const originY = Math.max(0, Math.floor(Math.min(...ys) - margin));
  const width = Math.min(photo.width - originX, Math.ceil(Math.max(...xs) + margin) - originX);
  const height = Math.min(photo.height - originY, Math.ceil(Math.max(...ys) + margin) - originY);
  if (width < 40 || height < 40) return null;
  let context = ImageManipulator.manipulate(uri).crop({ originX, originY, width, height });
  // Rotation is clockwise for positive degrees; turn back by the text's tilt.
  if (Math.abs(textAngle) > 3) context = context.rotate(-textAngle);
  const image = await context.renderAsync();
  try {
    return (await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 })).uri;
  } finally {
    image.release();
    context.release();
  }
}

// Longest side of the label image handed to OCR after straightening (see labelWarp.warpSize).
const STRAIGHT_MAX_SIDE = 1280;

/**
 * Pre-processing before OCR: crops the photo around the label, maps the label's four corners onto
 * an upright rectangle (perspective correction, so a tilted or angled label reads like a flat
 * scan), then grayscale and a contrast stretch. Returns the new image's URI (caller deletes it), or
 * null when it can't run; `cropLabel` is the rotate-only fallback.
 */
export async function straightenLabel(uri: string, photo: Size, quad: Quad, textAngle: number): Promise<string | null> {
  if (!hasStickerDetection) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so older builds don't crash on startup
  const { ImageManipulator, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same as above
  const { cacheDirectory, writeAsStringAsync } = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  if (!cacheDirectory) return null;

  // A small margin so letters on the label's edge aren't cut, and corner 0 at the text's top-left.
  const q = orientQuad(expandQuad(quad, 0.05), textAngle);
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const originX = Math.max(0, Math.floor(Math.min(...xs)));
  const originY = Math.max(0, Math.floor(Math.min(...ys)));
  const width = Math.min(photo.width, Math.ceil(Math.max(...xs))) - originX;
  const height = Math.min(photo.height, Math.ceil(Math.max(...ys))) - originY;
  if (width < 40 || height < 40) return null;

  // Decoding in JS is the slow part, so the crop is first scaled to about the output's size.
  const scale = Math.min(1, STRAIGHT_MAX_SIDE / Math.max(width, height));
  const context = ImageManipulator.manipulate(uri).crop({ originX, originY, width, height }).resize({ width: Math.round(width * scale) });
  const image = await context.renderAsync();
  let base64: string | undefined;
  try {
    base64 = (await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.95, base64: true })).base64;
  } finally {
    image.release();
    context.release();
  }
  if (!base64) return null;
  const pixels = decode(base64ToBytes(base64), { useTArray: true, formatAsRGBA: true });
  const k = pixels.width / width;
  const local = q.map((p) => ({ x: (p.x - originX) * k, y: (p.y - originY) * k })) as Quad;
  const gray = straighten(pixels, local, warpSize(local, 800, STRAIGHT_MAX_SIDE));
  const out = `${cacheDirectory}label-${Date.now()}.bmp`;
  await writeAsStringAsync(out, bytesToBase64(encodeGrayBmp(gray)), { encoding: 'base64' });
  return out;
}

/** The detection itself, on already-decoded RGBA pixels (a scaled-down copy of the photo). */
export function stickerFromPixels(img: { width: number; height: number; data: Uint8Array }, photo: Size, text: Rect): Quad | null {
  const { width: W, height: H, data } = img;
  const k = W / photo.width;
  const t = { x: Math.floor(text.x * k), y: Math.floor(text.y * k), w: Math.ceil(text.w * k), h: Math.ceil(text.h * k) };
  const inText = (x: number, y: number) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;

  const light = new Float32Array(W * H);
  const sat = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    light[i] = (r + g + b) / 3;
    sat[i] = max ? (max - min) / max : 0;
  }

  // The paper's brightness: the bright end of the pixels around the text (the rest is ink).
  const sample: number[] = [];
  for (let y = Math.max(0, t.y); y < Math.min(H, t.y + t.h); y += 1) for (let x = Math.max(0, t.x); x < Math.min(W, t.x + t.w); x += 1) sample.push(light[y * W + x]);
  if (sample.length < 20) return null;
  sample.sort((a, b) => a - b);
  const paper = sample[Math.floor(sample.length * 0.8)];
  const threshold = paper * 0.78;
  const paperPixel = (i: number) => light[i] >= threshold && sat[i] < 0.28;
  // The text box is level while a tilted label is not, so its corners can lie on the carton: inside
  // it the fill may cross ink (dark or colourless) but not cardboard, and only paper shapes the outline.
  const isPaper = (i: number, x: number, y: number) => paperPixel(i) || (inText(x, y) && (sat[i] < 0.28 || light[i] < paper * 0.4));

  // Flood-fill the paper outward from the text.
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const cx0 = Math.min(W - 1, Math.max(0, Math.round(t.x + t.w / 2)));
  const cy0 = Math.min(H - 1, Math.max(0, Math.round(t.y + t.h / 2)));
  stack.push(cy0 * W + cx0);
  seen[cy0 * W + cx0] = 1;
  const xs: number[] = [];
  const ys: number[] = [];
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W, y = (i - x) / W;
    if (paperPixel(i)) { xs.push(x); ys.push(y); }
    const next = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const n of next) {
      if (n < 0 || seen[n]) continue;
      const nx = n % W, ny = (n - nx) / W;
      if (!isPaper(n, nx, ny)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }

  // Too little paper: not a label. Too big: leaked into a white background, so no clear sticker.
  // (Compared with the level text box, which a tilted label only partly fills.)
  const share = xs.length / (W * H);
  if (share < 0.02 || share > 0.8 || xs.length < t.w * t.h * 0.25) return null;

  // The sticker's outline: its convex hull, cut down to the four corners that keep the most area.
  // Perspective makes a rectangle sticker look like any four-sided shape, so corners beat a rectangle.
  const hull = convexHull(xs, ys, W);
  if (hull.length < 4) return null;
  const quad = toFourCorners(hull);
  // Corners are in photo pixels, clockwise from the top-left.
  return orderCorners(quad).map((p) => ({ x: p.x / k, y: p.y / k })) as Quad;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (monotone chain) of the region, using each row's leftmost and rightmost pixel. */
function convexHull(xs: number[], ys: number[], W: number): Point[] {
  const left = new Map<number, number>();
  const right = new Map<number, number>();
  for (let i = 0; i < xs.length; i += 1) {
    const y = ys[i], x = xs[i];
    if (!left.has(y) || x < left.get(y)!) left.set(y, x);
    if (!right.has(y) || x > right.get(y)!) right.set(y, x);
  }
  const pts: Point[] = [];
  left.forEach((x, y) => pts.push({ x, y }));
  right.forEach((x, y) => pts.push({ x: x + 1, y }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3 || W <= 0) return pts;
  const lower: Point[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drops hull points one at a time, always the one whose removal loses the least area, until four remain. */
function toFourCorners(hull: Point[]): Point[] {
  const pts = hull.slice();
  const loss = (i: number) => Math.abs(cross(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]));
  while (pts.length > 4) {
    let best = 0;
    for (let i = 1; i < pts.length; i += 1) if (loss(i) < loss(best)) best = i;
    pts.splice(best, 1);
  }
  return pts;
}

/** Clockwise (on screen) from the corner nearest the top-left. */
function orderCorners(pts: Point[]): Point[] {
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[first].x + sorted[first].y) first = i; });
  return sorted.slice(first).concat(sorted.slice(0, first));
}
