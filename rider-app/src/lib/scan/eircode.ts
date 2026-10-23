// Eircodes in camera text. An Eircode is a routing key (a letter and two digits, or D6W) and a four-character unique
// identifier, e.g. "D06 YP22". The scanner reads only this: the address always comes from the map lookup.

// Letters used in Eircodes (no B, G, I, J, L, M, O, Q, S, U, Z).
const LETTERS = 'ACDEFHKNPRTVWXY';
const EIRCODE_ONLY = new RegExp(`^((?:[${LETTERS}]\\d{2}|D6W))([0-9${LETTERS}]{4})$`);

// The 139 routing keys in use. Text that only looks like an Eircode ("A12 3456" as a parcel number) is rejected.
const KNOWN_KEYS = new Set(
  ('A41 A42 A45 A63 A67 A75 A81 A82 A83 A84 A85 A86 A91 A92 A94 A96 A98 C15 D01 D02 D03 D04 D05 D06 D07 D08 D09 D10 D11 D12 D13 '
    + 'D14 D15 D16 D17 D18 D20 D22 D24 D6W E21 E25 E32 E34 E41 E45 E53 E91 F12 F23 F26 F28 F31 F35 F42 F45 F52 F56 F91 F92 F93 '
    + 'F94 H12 H14 H16 H18 H23 H53 H54 H62 H65 H71 H91 K32 K34 K36 K45 K56 K67 K78 N37 N39 N41 N91 P12 P14 P17 P24 P25 P31 P32 '
    + 'P36 P43 P47 P51 P56 P61 P67 P72 P75 P81 P85 R14 R21 R32 R35 R42 R45 R51 R56 R93 R95 T12 T23 T34 T45 T56 V14 V15 V23 V31 '
    + 'V35 V42 V92 V93 V94 V95 W12 W23 W34 W91 X35 X42 X91 Y14 Y21 Y25 Y34 Y35').split(' '),
);

// OCR look-alikes, applied only where the format rules the printed character out, so a valid character is never
// changed. Digit slots (the routing key's two digits): letters that look like digits.
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
// The routing key's letter slot: digits (and invalid letters) that look like a valid letter.
const TO_LETTER: Record<string, string> = { '0': 'D', O: 'D', Q: 'D', '4': 'A', M: 'N' };
// Unique-ID slots accept digits and valid letters; invalid letters map to what they are usually misread from.
const ID_CHAR: Record<string, string> = { O: '0', Q: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', G: '6', B: '8', U: 'V', M: 'N' };
const MAX_REPAIRS = 2;
// The printed caption next to the code ("EIRCODE: R93 Y201", "Eircode R93Y201"), never part of it.
const CAPTION = /\b(?:EIR\s?CODE|POST\s?CODE|POSTCODE)\b[:.]?/g;

/** "D06 YP22" for any spelling of a valid Eircode ("d06yp22", "D06-YP22"), else null. No repairs. */
export function normalizeEircode(text: string): string | null {
  const m = EIRCODE_ONLY.exec(text.toUpperCase().replace(/[\s-]+/g, ''));
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Fixes look-alikes in a 7-character token; returns the result and how many characters changed. */
function repair(token: string): { value: string; changes: number } {
  let changes = 0;
  const fix = (ch: string, map: Record<string, string>) => {
    const next = map[ch];
    if (next === undefined) return ch;
    changes += 1;
    return next;
  };
  const key = token.startsWith('D6W') ? 'D6W'
    : (LETTERS.includes(token[0]) ? token[0] : fix(token[0], TO_LETTER))
      + (/\d/.test(token[1]) ? token[1] : fix(token[1], TO_DIGIT))
      + (/\d/.test(token[2]) ? token[2] : fix(token[2], TO_DIGIT));
  const id = [...token.slice(3)].map((ch) => (/\d/.test(ch) || LETTERS.includes(ch) ? ch : fix(ch, ID_CHAR))).join('');
  return { value: key + id, changes };
}

/**
 * Every Eircode in a line of camera text, normalised to "XXX XXXX", in order. Codes split over up to three words
 * ("A9 2EDWE") and common OCR look-alikes ("R93 Y2O1") are found; anything that is not a real routing key is not.
 */
export function findEircodes(line: string): string[] {
  const upper = line.toUpperCase().replace(CAPTION, ' ');
  const words = upper.match(/[A-Z0-9]+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + 3); j += 1) {
      joined += words[j];
      if (joined.length > 8) break;
      // "VV" is a common misreading of "W".
      const vv = joined.length === 8 && joined.includes('VV');
      if (joined.length !== 7 && !vv) continue;
      const compact = vv ? joined.replace('VV', 'W') : joined;
      // At least one real digit in the routing key, so plain words ("DOLPHIN") are never read as codes.
      if (!/\d/.test(compact.slice(1, 3))) continue;
      const { value, changes } = repair(compact);
      const m = EIRCODE_ONLY.exec(value);
      if (!m || !KNOWN_KEYS.has(m[1]) || changes + (vv ? 1 : 0) > MAX_REPAIRS) continue;
      out.push(`${m[1]} ${m[2]}`);
      i = j;
      break;
    }
  }
  return out;
}

/** The distinct Eircodes in a block of camera text (one line per row, as the recogniser returns it). */
export function eircodesInText(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).flatMap(findEircodes))];
}
