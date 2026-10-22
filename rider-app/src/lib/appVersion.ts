/** Numeric compare of "1.4.2"-style versions (missing parts count as 0): negative, 0 or positive like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** "required" below the server's minimum version, "suggested" below its latest one, else "none". */
export function updateNeeded(current: string | null | undefined, min?: string | null, latest?: string | null): 'required' | 'suggested' | 'none' {
  if (!current) return 'none';
  if (min && compareVersions(current, min) < 0) return 'required';
  if (latest && compareVersions(current, latest) < 0) return 'suggested';
  return 'none';
}
