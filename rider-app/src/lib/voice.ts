// What speech recognition hears, made into an address. An Eircode spoken character by character comes back in pieces
// ("P1 2 FY 70", "p 12 f y 7 0", "P one two FY seven zero"); it is joined into one code ("P12 FY70"). The rest of the
// text is left as heard.

import { findEircodes } from './scan/eircode';

// Spoken digits. "Oh" for 0 only counts inside a run that turns out to be an Eircode.
const DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
// "Double seven" = 77, "triple zero" = 000.
const REPEAT: Record<string, number> = { double: 2, triple: 3 };
// The longest run of spoken pieces one Eircode can be heard as (7 characters, each said apart, plus a "double").
const MAX_PIECES = 8;

/** A short piece that can be part of a spoken Eircode ("P1", "2", "FY", "seven"), as characters, else null. */
function piece(word: string): string | null {
  const w = word.toLowerCase().replace(/[.,]/g, '');
  if (w in DIGITS) return DIGITS[w];
  if (/^[a-z0-9]{1,4}$/.test(w)) return w.toUpperCase();
  return null;
}

/** Joins an Eircode heard in pieces into "P12 FY70"; everything else stays as it was said. */
export function voiceToAddress(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    let found: { code: string; end: number } | null = null;
    let times = 1;
    for (let j = i; j < Math.min(words.length, i + MAX_PIECES); j += 1) {
      const w = words[j].toLowerCase();
      if (w in REPEAT) { times = REPEAT[w]; continue; }
      const part = piece(words[j]);
      if (!part) break;
      joined += part.repeat(part.length === 1 ? times : 1);
      times = 1;
      if (joined.length > 7) break;
      // Two pieces or more: one word on its own is already handled by the usual Eircode tidy-up.
      if (joined.length === 7 && j > i) {
        const [code] = findEircodes(joined);
        if (code) found = { code, end: j };
        break;
      }
    }
    if (found) {
      out.push(found.code);
      i = found.end;
    } else {
      out.push(words[i]);
    }
  }
  return out.join(' ');
}
