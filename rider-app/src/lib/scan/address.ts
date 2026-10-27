// Irish street addresses read by the camera (or typed): clean-up, short forms, and checks against map suggestions.
//
// What the rider sees stays close to what is printed: only spacing and clear OCR slips are fixed ("26shanecastle" →
// "26 shanecastle", "C1" → "Cl"). Short forms ("Cl", "Cre", "Dr") are expanded only for the map search and for
// comparing a suggestion with what was asked for, so a wrong guess never shows up as the rider's own text.
// Every short form lives in STREET_TYPES / OTHER_WORDS below: a new one is one entry.

/** Street types, keyed by the full word, with every spelling seen on labels (lower case, no dots or accents). */
export const STREET_TYPES: Readonly<Record<string, readonly string[]>> = {
  road: ['road', 'rd', 'bothar'],
  street: ['street', 'st', 'str', 'sraid'],
  avenue: ['avenue', 'ave', 'av', 'ascal'],
  drive: ['drive', 'dr', 'drv', 'ceide'],
  close: ['close', 'cl', 'cls'],
  crescent: ['crescent', 'cres', 'cre', 'cresc', 'crs'],
  grove: ['grove', 'gr', 'grv', 'garran'],
  park: ['park', 'pk', 'prk', 'pairc'],
  court: ['court', 'ct', 'crt', 'cuirt'],
  terrace: ['terrace', 'tce', 'terr', 'ter'],
  place: ['place', 'pl'],
  square: ['square', 'sq'],
  lane: ['lane', 'ln', 'lana'],
  gardens: ['gardens', 'gdns', 'gdn', 'gds'],
  heights: ['heights', 'hts'],
  green: ['green', 'grn'],
  lawn: ['lawn', 'lwn'],
  lawns: ['lawns', 'lwns'],
  view: ['view', 'vw'],
  walk: ['walk', 'wk'],
  parade: ['parade', 'pde'],
  estate: ['estate', 'est'],
  way: ['way'], rise: ['rise'], hill: ['hill'], mews: ['mews'], vale: ['vale'], row: ['row'], wood: ['wood'],
  meadows: ['meadows'], glen: ['glen'], downs: ['downs'], manor: ['manor'], grange: ['grange'], quay: ['quay'],
};

/** Other short forms on Irish labels. Only used for the search text, never for the street-type check. */
const OTHER_WORDS: Readonly<Record<string, string>> = {
  upr: 'Upper', lwr: 'Lower', nth: 'North', sth: 'South', mt: 'Mount', apt: 'Apartment', co: 'County',
};

// spelling → full street type ("cre" → "crescent").
const TYPE_OF = new Map<string, string>();
for (const [type, spellings] of Object.entries(STREET_TYPES)) {
  for (const spelling of spellings) TYPE_OF.set(spelling, type);
}

// Irish-language types come before the name ("Bóthar Mhuire" is Mary's Road), so a part may start with one.
const TYPE_FIRST = new Set(['bothar', 'sraid', 'ascal', 'ceide', 'garran', 'pairc', 'cuirt', 'lana']);

// "St", "Dr" and "Mt" right after the house number (or at the start) are a title: "26 St Mary's Rd" is Saint Mary's
// Road, "Main St" is Main Street.
const TITLES: Readonly<Record<string, string>> = { st: 'Saint', dr: 'Doctor', mt: 'Mount' };

// Clear OCR slips in a whole word, seen on printed labels: "Cl" read as "C1"/"CI", "St" read as "5t".
const OCR_WORDS: Readonly<Record<string, string>> = { c1: 'Cl', ci: 'Cl', 'c|': 'Cl', '5t': 'St', '0r': 'Dr', 'r0': 'Rd' };

// An Eircode in the text ("D22 XY12" / "D22XY12"): kept exactly as read, never split or "fixed" as a word.
const EIRCODE = /\b(?:[ACDEFHKNPRTVWXY]\d{2}|D6W) ?[0-9ACDEFHKNPRTVWXY]{4}\b/gi;

/** Lower case without accents or dots, for looking words up ("Bóthar" → "bothar", "Rd." → "rd"). */
const plain = (word: string) => word.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').toLowerCase();

const ordinalSuffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');

/** Puts a space where the camera (or a fast thumb) dropped one, keeping Eircodes and "1st"/"2nd" as they are. */
function fixSpacing(text: string): string {
  const kept: string[] = [];
  let out = text.replace(EIRCODE, (code) => { kept.push(code); return `\u0000${kept.length - 1}\u0000`; });
  // "26shanecastle" → "26 shanecastle" (3 or more letters after a number: "26A" stays a house number).
  out = out.replace(/(\d+)([A-Za-zÀ-ɏ]{2,})/g, (whole, num: string, word: string) => {
    if (word.length === 2 && plain(word) === ordinalSuffix(Number(num))) return whole;
    return word.length >= 3 ? `${num} ${word}` : whole;
  });
  // "Dublin22" → "Dublin 22".
  out = out.replace(/([A-Za-zÀ-ɏ]{3,})(\d{1,2})\b/g, '$1 $2');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}

/**
 * The text to put in the address field after a scan: spacing and clear OCR slips fixed, stray symbols dropped, lines
 * joined with ", ". Nothing is expanded or re-worded.
 */
export function cleanAddressText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\p{L}\p{N}\s,.'\-/#&|]/gu, ' '))
    .map((line) => fixSpacing(line))
    .map((line) => line.split(/\s+/).filter(Boolean).map((word) => {
      const bare = word.replace(/[.,]+$/, '');
      const fixed = OCR_WORDS[bare.toLowerCase()];
      return fixed ? fixed + word.slice(bare.length) : word;
    }).join(' ').replace(/\s+,/g, ',').replace(/,+/g, ',').replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean);
  return lines.join(', ');
}

// `comma`: the word ends a part of the address. `soft`: that end is an Eircode taken out, not a comma in the text.
type Token = { word: string; key: string; comma: boolean; soft?: boolean };

/** Words with their lookup key; `comma` is true when the word ends a comma-separated part. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of fixSpacing(text).replace(EIRCODE, ' \u0001 ').split(/\s+/)) {
    if (!raw) continue;
    if (raw === '\u0001') {
      const last = out[out.length - 1];
      if (last && !last.comma) { last.comma = true; last.soft = true; }
      continue;
    }
    const parts = raw.split(',');
    parts.forEach((part, i) => {
      const word = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
      // A clear OCR slip ("C1") is looked up as the word it stands for, also in text the rider has not cleaned.
      const slip = OCR_WORDS[word.toLowerCase()];
      if (word) out.push({ word: slip ?? word, key: plain(slip ?? word), comma: false });
      if (i < parts.length - 1 && out.length) out[out.length - 1].comma = true;
    });
  }
  return out;
}

const isNumber = (key: string) => /^\d+[a-z]?$/.test(key);

/** True when the short form at `i` is a title ("26 St Mary's Rd"), not a street type ("Main St"). */
function isTitle(list: Token[], i: number): boolean {
  if (!(list[i].key in TITLES)) return false;
  const prev = list[i - 1];
  const next = list[i + 1];
  if (!next || list[i].comma) return false;
  return !prev || prev.comma || isNumber(prev.key);
}

/**
 * The street type of an address ("grove" for "26 Shanecastle Grove, Clondalkin"), or null when it has none. It is the
 * last street-type word in the first comma part that has one, so "Hill Street" is a street and "Oak Park Dr" a drive.
 */
export function streetType(text: string): string | null {
  const list = tokens(text);
  let found: string | null = null;
  for (let i = 0; i < list.length; i += 1) {
    const type = TYPE_OF.get(list[i].key);
    // The first word of a part is a name, not a type ("Park Avenue", "Grove Road"), unless it is the only word.
    const startsPart = i === 0 || list[i - 1].comma || isNumber(list[i - 1].key);
    const nameWord = startsPart && list[i + 1] && !list[i].comma && !TYPE_FIRST.has(list[i].key);
    if (type && !isTitle(list, i) && !nameWord) found = type;
    if (list[i].comma && found) return found;
  }
  return found;
}

// A number after these words is not the house number ("Apt 4", "Dublin 22", "Unit 7").
const NOT_HOUSE = new Set(['apt', 'apartment', 'unit', 'flat', 'dublin', 'd', 'co', 'block', 'floor', 'suite']);

/** The house number ("26", "26a"), or null. Eircodes, "Dublin 22" and apartment numbers are skipped. */
export function houseNumber(text: string): string | null {
  const list = tokens(text);
  for (let i = 0; i < list.length; i += 1) {
    const prev = list[i - 1];
    const range = /^(\d+[a-z]?)-\d+[a-z]?$/.exec(list[i].key);
    const key = range ? range[1] : list[i].key;
    if (isNumber(key) && !(prev && !prev.comma && NOT_HOUSE.has(prev.key))) return key;
  }
  return null;
}

/**
 * The text sent to the map search: street types and other short forms written out ("26 Shanecastle Cl" → "26
 * Shanecastle Close"), titles kept as titles ("26 St Mary's Rd" → "26 Saint Mary's Road").
 */
export function expandForSearch(text: string): string {
  const list = tokens(text);
  const words = list.map((t, i) => {
    if (isTitle(list, i)) return TITLES[t.key];
    const type = TYPE_OF.get(t.key);
    const full = type && type !== t.key ? type : OTHER_WORDS[t.key]?.toLowerCase();
    const word = full ? full[0].toUpperCase() + full.slice(1) : t.word;
    return t.comma && !t.soft ? `${word},` : word;
  });
  // Eircodes were taken out of the words; they go back at the end, where the map search reads them best.
  const codes = text.match(EIRCODE) ?? [];
  return [...words, ...codes].join(' ').replace(/,\s*$/, '').trim();
}

export type AddressIssue =
  | { kind: 'street'; wanted: string; got: string }
  | { kind: 'number'; wanted: string; got: string };

/**
 * What differs between the address asked for and a map suggestion: the street type ("Grove" asked, "Park" found)
 * or the house number. Only a difference counts: a suggestion without a number or type is not flagged.
 */
export function suggestionIssues(asked: string, suggestion: string): AddressIssue[] {
  const issues: AddressIssue[] = [];
  const wantedType = streetType(asked);
  const gotType = streetType(suggestion);
  if (wantedType && gotType && wantedType !== gotType) issues.push({ kind: 'street', wanted: wantedType, got: gotType });
  const wantedNo = houseNumber(asked);
  const gotNo = houseNumber(suggestion);
  if (wantedNo && gotNo && wantedNo !== gotNo) issues.push({ kind: 'number', wanted: wantedNo, got: gotNo });
  return issues;
}

/** One line for the rider, e.g. "Park, not Grove" or "No. 22, not 26". */
export function issueText(issue: AddressIssue): string {
  const title = (word: string) => word[0].toUpperCase() + word.slice(1);
  return issue.kind === 'street' ? `${title(issue.got)}, not ${title(issue.wanted)}` : `No. ${issue.got.toUpperCase()}, not ${issue.wanted.toUpperCase()}`;
}

/** Suggestions with their issues, the ones that match what was asked first (order otherwise kept). */
export function rankSuggestions<T>(asked: string, list: readonly T[], label: (item: T) => string): { item: T; issues: AddressIssue[] }[] {
  const checked = list.map((item) => ({ item, issues: suggestionIssues(asked, label(item)) }));
  return [...checked.filter((c) => !c.issues.length), ...checked.filter((c) => c.issues.length)];
}
