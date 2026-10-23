/** Proof photos are sent at most this many pixels on their longest side: enough to read a door number, ~10x smaller than a phone camera's photo. */
export const PROOF_MAX_EDGE = 1600;
export const PROOF_JPEG_QUALITY = 0.7;

/** The resize for a width × height photo (one side set, the other follows), or null when it is already small enough. */
export function proofResize(width: number | undefined, height: number | undefined, maxEdge = PROOF_MAX_EDGE): { width: number } | { height: number } | null {
  if (!width || !height || Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}
