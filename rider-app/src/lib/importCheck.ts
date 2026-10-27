// Import: which rows of a file can become stops straight away, and what is wrong with the others. Pure, so it is
// unit-tested. A row is only added on its own when the map placed it at the door, on the street that was asked for,
// and it is not already a stop; anything else waits for the rider.

import { findDuplicate, type StopLike } from './duplicates';
import { findEircode, isOnlyEircode } from './format';
import { expandForSearch, issueText, suggestionIssues } from './scan/address';

type Point = { latitude: number; longitude: number };

/** What the map said about one address (POST /deliveries/geocode-check-batch). */
export type AddressCheck = {
  found: boolean; approximate: boolean; latitude: number | null; longitude: number | null;
  normalized: string | null; postalCode: string | null; error?: boolean;
};

export type ImportIssue = 'incomplete' | 'lookup_failed' | 'not_found' | 'different' | 'approximate' | 'duplicate';

export type RowCheck =
  | { status: 'ready'; point: Point; normalized: string | null; precise: boolean; eircode: string | null }
  | { status: 'problem'; issue: ImportIssue; detail: string; check: AddressCheck | null; eircode: string | null };

/** The text sent to the map: short forms written out ("Cl" → "Close"); an Eircode on its own as it is. */
export const lookupText = (address: string) => (isOnlyEircode(address) ? address.trim() : expandForSearch(address));

/** A stop accepted earlier in the same file, so a repeated row is caught before it is saved. */
export type Accepted = { id: string; raw: string; normalized: string | null; eircode: string | null; point: Point; precise: boolean };

const asStop = (a: Accepted): StopLike => ({
  id: a.id,
  address: {
    raw: a.raw, normalized: a.normalized, postalCode: a.eircode, latitude: a.point.latitude, longitude: a.point.longitude,
    approximate: !a.precise, geocodeStatus: 'found',
  },
});

export const ISSUE_LABEL: Record<ImportIssue, string> = {
  incomplete: 'Address missing',
  lookup_failed: 'Not checked',
  not_found: 'Not found',
  different: 'Different address',
  approximate: 'Area only',
  duplicate: 'Already added',
};

/**
 * One row's verdict. `existing` are the stops already on the list, `earlier` the rows of this file accepted before it.
 * An Eircode on its own counts as the door even when the map only has the area (as when it is typed in Add stops).
 */
export function checkRow(address: string, check: AddressCheck | null, existing: readonly StopLike[], earlier: readonly Accepted[]): RowCheck {
  const text = address.trim();
  const eircode = findEircode(text) || check?.postalCode || findEircode(check?.normalized) || null;
  const problem = (issue: ImportIssue, detail: string): RowCheck => ({ status: 'problem', issue, detail, check, eircode });
  if (text.length < 5) return problem('incomplete', 'Type the full address or the Eircode.');
  if (!check || check.error) return problem('lookup_failed', 'The address could not be checked. Check again.');

  const point = check.found && check.latitude != null && check.longitude != null ? { latitude: check.latitude, longitude: check.longitude } : null;
  const precise = !!point && (!check.approximate || isOnlyEircode(text));
  const duplicate = findDuplicate({ eircode, point: precise ? point : null }, [...existing, ...earlier.map(asStop)]);
  if (duplicate) {
    const inFile = duplicate.index >= existing.length;
    return problem('duplicate', inFile ? 'The same address is higher up in this file.' : `Already in your stops (#${duplicate.index + 1}).`);
  }
  if (!point) return problem('not_found', 'The map could not find this address. Fix the spelling or add the Eircode.');
  const issues = check.normalized ? suggestionIssues(text, check.normalized) : [];
  if (issues.length) return problem('different', `The map found ${check.normalized} (${issues.map(issueText).join(', ')}).`);
  if (!precise) return problem('approximate', `The map only found the area: ${check.normalized ?? 'no street'}. Add the house number or Eircode.`);
  return { status: 'ready', point, normalized: check.normalized, precise, eircode };
}
