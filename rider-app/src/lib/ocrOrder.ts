// Puts OCR lines in reading order. ML Kit returns text blocks in no reliable order, and on a tilted
// label "top to bottom" on screen is not top to bottom on the label. Line centres are turned to the
// label's own axes first, then grouped into rows and read left to right.

export type OcrPoint = { x: number; y: number };
export type OcrLine = { text: string; frame: { left: number; top: number; width: number; height: number } | null; corners?: OcrPoint[] | null };

/** The text's tilt in degrees, from each line's top edge (median, so one odd line can't skew it). */
export function textAngle(lines: OcrLine[]): number {
  const angles = lines
    .filter((l) => l.corners && l.corners.length >= 2 && l.text.length >= 4)
    .map((l) => (Math.atan2(l.corners![1].y - l.corners![0].y, l.corners![1].x - l.corners![0].x) * 180) / Math.PI)
    .sort((a, b) => a - b);
  return angles.length ? angles[Math.floor(angles.length / 2)] : 0;
}

export function readingOrder(lines: OcrLine[], angleDeg = textAngle(lines)): string[] {
  const placed = lines.filter((l) => l.frame && l.text.trim());
  const loose = lines.filter((l) => !l.frame && l.text.trim()).map((l) => l.text);
  const a = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const items = placed.map((l) => {
    const cx = l.frame!.left + l.frame!.width / 2;
    const cy = l.frame!.top + l.frame!.height / 2;
    // Height of a line is its short side once turned upright.
    const h = Math.min(l.frame!.height, Math.abs(angleDeg) > 45 ? l.frame!.width : l.frame!.height);
    return { text: l.text, x: cx * cos - cy * sin, y: cx * sin + cy * cos, h: Math.max(1, h) };
  });
  const heights = items.map((i) => i.h).sort((p, q) => p - q);
  const rowGap = (heights[Math.floor(heights.length / 2)] || 10) * 0.6;

  items.sort((p, q) => p.y - q.y);
  const rows: (typeof items)[] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.y - row[0].y) <= rowGap) row.push(item); else rows.push([item]);
  }
  return [...rows.flatMap((row) => row.sort((p, q) => p.x - q.x).map((i) => i.text)), ...loose];
}
