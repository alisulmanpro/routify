// Straightens a photographed label before OCR: the label's four corners are mapped onto an upright
// rectangle (perspective correction), then the result is turned to grayscale and its contrast
// stretched. A tilted or angled label then reads like a flat scan, which matters most for short
// codes such as Eircodes, where one skewed character changes the whole code.
//
// Everything here is plain arithmetic on pixel arrays, so it runs (and is tested) without native code.
// expo-image-manipulator can crop, resize and rotate but has no perspective warp or colour filters.
import type { Point, Quad, Rect, Size } from './labelTracking';

export type Rgba = { width: number; height: number; data: Uint8Array };
export type Gray = { width: number; height: number; data: Uint8Array };

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Moves each corner away from the centre by `fraction` of its distance, so the warp keeps a margin. */
export function expandQuad(q: Quad, fraction: number): Quad {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4;
  const cy = q.reduce((s, p) => s + p.y, 0) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * (1 + fraction), y: cy + (p.y - cy) * (1 + fraction) })) as Quad;
}

const quadArea = (q: Quad) => Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;

/**
 * Whether a detected sticker outline can be trusted for the warp: it must contain the text's centre
 * and not be far bigger than the text. On a white or grey background the paper search can run off
 * the label into the background, and warping that would shrink the text instead of straightening it.
 */
export function plausibleSticker(q: Quad, text: Rect, maxRatio = 8) {
  const cx = text.x + text.w / 2, cy = text.y + text.h / 2;
  const inside = q.every((p, i) => { const n = q[(i + 1) % 4]; return (n.x - p.x) * (cy - p.y) - (n.y - p.y) * (cx - p.x) >= 0; })
    || q.every((p, i) => { const n = q[(i + 1) % 4]; return (n.x - p.x) * (cy - p.y) - (n.y - p.y) * (cx - p.x) <= 0; });
  return inside && quadArea(q) <= maxRatio * Math.max(1, text.w * text.h);
}

/**
 * Picks which corner is the label's top-left, so the warped label comes out with its text upright.
 * `q` is clockwise on screen; `textAngleDeg` is the text's tilt from the OCR lines. The corner whose
 * top edge runs closest to the text's direction becomes corner 0.
 */
export function orientQuad(q: Quad, textAngleDeg: number): Quad {
  let best = 0;
  let bestDiff = Infinity;
  for (let k = 0; k < 4; k += 1) {
    const a = q[k], b = q[(k + 1) % 4];
    const edge = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const diff = Math.abs(((edge - textAngleDeg + 540) % 360) - 180);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  return [0, 1, 2, 3].map((i) => q[(best + i) % 4]) as Quad;
}

/**
 * Output size for the warped label: its real width and height (average of opposite edges), scaled
 * so the long side is between `minSide` and `maxSide`. Small labels are enlarged a little because
 * text recognition struggles with characters only a few pixels tall.
 */
export function warpSize(q: Quad, minSide = 900, maxSide = 1400): Size {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const long = Math.max(1, w, h);
  const scale = Math.min(maxSide, Math.max(minSide, long)) / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * The projective map from the unit square to `q` (corner 0 at (0,0), 1 at (1,0), 2 at (1,1), 3 at
 * (0,1)). Returns a function giving the source point for (u, v) in [0, 1].
 */
export function squareToQuad(q: Quad): (u: number, v: number) => Point {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-9) {
      g = (sx * dy2 - dx2 * sy) / den;
      h = (dx1 * sy - sx * dy1) / den;
    }
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}

/** Luminance of every pixel (0-255). */
export function toGray(img: Rgba): Gray {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) out[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return { width: img.width, height: img.height, data: out };
}

/** Warps the label inside `q` (source pixels) to an upright grayscale image of `size`. */
export function warpToGray(img: Rgba, q: Quad, size: Size): Gray {
  const src = toGray(img);
  const { width: W, height: H, data } = src;
  const map = squareToQuad(q);
  const out = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y += 1) {
    const v = (y + 0.5) / size.height;
    for (let x = 0; x < size.width; x += 1) {
      const p = map((x + 0.5) / size.width, v);
      // Bilinear sample; outside the photo is white (paper), which OCR ignores.
      const fx = p.x - 0.5, fy = p.y - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) { out[y * size.width + x] = 255; continue; }
      const tx = fx - x0, ty = fy - y0;
      const i = y0 * W + x0;
      const top = data[i] + (data[i + 1] - data[i]) * tx;
      const bottom = data[i + W] + (data[i + W + 1] - data[i + W]) * tx;
      out[y * size.width + x] = top + (bottom - top) * ty;
    }
  }
  return { width: size.width, height: size.height, data: out };
}

/**
 * Stretches the brightness range so the darkest 1% becomes black and the brightest 1% white.
 * Faded print gets darker and grey paper whiter; it is a linear stretch, not a black/white
 * threshold, because text recognition does better with smooth edges than with hard binarised ones.
 */
export function stretchContrast(img: Gray, clip = 0.01): Gray {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 1) hist[img.data[i]] += 1;
  const cut = img.data.length * clip;
  let low = 0, high = 255, seen = 0;
  for (; low < 255; low += 1) { seen += hist[low]; if (seen > cut) break; }
  seen = 0;
  for (; high > 0; high -= 1) { seen += hist[high]; if (seen > cut) break; }
  // Nearly flat image (blank paper): nothing to stretch.
  if (high - low < 24) return img;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) lut[v] = Math.max(0, Math.min(255, Math.round(((v - low) * 255) / (high - low))));
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = lut[img.data[i]];
  return { width: img.width, height: img.height, data: out };
}

/** The full pre-processing: perspective-correct, grayscale, contrast. */
export function straighten(img: Rgba, q: Quad, size = warpSize(q)): Gray {
  return stretchContrast(warpToGray(img, q, size));
}

/**
 * An 8-bit grayscale BMP. BMP needs no compression code (jpeg-js's encoder relies on Node's Buffer,
 * which React Native lacks) and is read by Android and iOS image decoders, and so by ML Kit.
 */
export function encodeGrayBmp(img: Gray): Uint8Array {
  const rowSize = (img.width + 3) & ~3;
  const pixelOffset = 14 + 40 + 256 * 4;
  const fileSize = pixelOffset + rowSize * img.height;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; // "BM"
  view.setUint32(2, fileSize, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, img.width, true);
  view.setInt32(22, img.height, true); // positive: rows stored bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);
  view.setUint32(34, rowSize * img.height, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 256, true);
  for (let v = 0; v < 256; v += 1) { const p = 54 + v * 4; out[p] = v; out[p + 1] = v; out[p + 2] = v; }
  for (let y = 0; y < img.height; y += 1) {
    out.set(img.data.subarray(y * img.width, (y + 1) * img.width), pixelOffset + (img.height - 1 - y) * rowSize);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    // Join in pieces so huge strings aren't built one character at a time.
    if (chunk.length >= 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}
