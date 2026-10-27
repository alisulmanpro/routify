// Lines of text found in a photo, for the address scanner: the rider taps the lines that make up one address.
// Plain data only (no React Native), so it is tested on its own.

import { eircodesInText } from './eircode';
import { cleanAddressText } from './address';

/** A box in the photo's own pixels (top-left corner, size). */
export type Box = { left: number; top: number; width: number; height: number };
export type PhotoLine = { id: string; text: string; box: Box };

type Frame = { boundingCenterX: number; boundingCenterY: number; width: number; height: number };
type Recognized = { blocks: { lines: { lineText: string; lineFrame: Frame }[] }[] };

// The recogniser's x/y differ between Android and iOS; the centre and size are the same on both.
const toBox = (f: Frame): Box => ({ left: f.boundingCenterX - f.width / 2, top: f.boundingCenterY - f.height / 2, width: f.width, height: f.height });

/** Every line of text worth showing (at least 2 letters or digits), in reading order: top to bottom, then left to right. */
export function photoLines(result: Recognized): PhotoLine[] {
  const lines = result.blocks.flatMap((block) => block.lines)
    .filter((line) => (line.lineText.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2 && line.lineFrame.width > 0 && line.lineFrame.height > 0)
    .map((line) => ({ text: line.lineText.trim(), box: toBox(line.lineFrame) }));
  return byReadingOrder(lines).map((line, i) => ({ id: String(i), ...line }));
}

/** Top to bottom; lines whose middles are within half a line height of each other count as one row, left to right. */
function byReadingOrder<T extends { box: Box }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => {
    const mid = (x: Box) => x.top + x.height / 2;
    const sameRow = Math.abs(mid(a.box) - mid(b.box)) < Math.min(a.box.height, b.box.height) / 2;
    return sameRow ? a.box.left - b.box.left : mid(a.box) - mid(b.box);
  });
}

export type PickedAddress =
  /** The chosen lines hold exactly one Eircode: it is used, as the surest way to the door. */
  | { kind: 'eircode'; eircode: string; text: string }
  | { kind: 'address'; text: string };

/** What the chosen lines give: the cleaned address text, or the Eircode when there is exactly one. Null if none chosen. */
export function pickAddress(lines: readonly PhotoLine[], chosen: ReadonlySet<string>): PickedAddress | null {
  const picked = byReadingOrder(lines.filter((line) => chosen.has(line.id)));
  if (!picked.length) return null;
  const raw = picked.map((line) => line.text).join('\n');
  const text = cleanAddressText(raw);
  const codes = eircodesInText(raw);
  return codes.length === 1 ? { kind: 'eircode', eircode: codes[0], text } : { kind: 'address', text };
}

/**
 * Where a photo of `image` size sits inside a `view` with `contain` fit: its scale and the offset of its top-left
 * corner, so the line boxes can be drawn over it.
 */
export function containFit(image: { width: number; height: number }, view: { width: number; height: number }) {
  const scale = Math.min(view.width / image.width, view.height / image.height);
  return { scale, left: (view.width - image.width * scale) / 2, top: (view.height - image.height * scale) / 2 };
}
