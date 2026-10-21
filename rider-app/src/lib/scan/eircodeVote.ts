// The live scanner locks an Eircode only once it has read the same code in most recent frames, so a single misread
// frame ("R93 Y2D1") never wins.

export const VOTE_WINDOW = 5;
export const VOTES_NEEDED = 3;

export type VoteResult =
  | { kind: 'none' }
  | { kind: 'locked'; eircode: string }
  /** Two or more different codes are steady in view (e.g. sender and recipient): the rider must frame just one. */
  | { kind: 'ambiguous'; eircodes: string[] };

export type EircodeVote = {
  /** Adds one processed frame's codes (empty when none were read) and says whether a code is now locked. */
  push: (codes: readonly string[]) => VoteResult;
  reset: () => void;
};

export function createEircodeVote(window = VOTE_WINDOW, needed = VOTES_NEEDED): EircodeVote {
  let frames: Set<string>[] = [];
  return {
    push(codes) {
      frames = [...frames, new Set(codes)].slice(-window);
      const counts = new Map<string, number>();
      for (const frame of frames) for (const code of frame) counts.set(code, (counts.get(code) ?? 0) + 1);
      const steady = [...counts].filter(([, n]) => n >= needed).map(([code]) => code);
      if (steady.length === 1) return { kind: 'locked', eircode: steady[0] };
      if (steady.length > 1) return { kind: 'ambiguous', eircodes: steady.sort() };
      return { kind: 'none' };
    },
    reset() {
      frames = [];
    },
  };
}
