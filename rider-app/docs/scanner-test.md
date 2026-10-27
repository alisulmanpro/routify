# Scanner test sheet (Android first, then iPhone)

Run this on a real phone with a development build. Fill in one row per try; the PR / report quotes the totals.

## Addresses

The client's four streets differ only by type, so a scanner that guesses the street is caught at once:

1. 26 Shanecastle Dr, Clondalkin, Dublin 22
2. 26 Shanecastle Cl, Clondalkin, Dublin 22
3. 26 Shanecastle Grove, Clondalkin, Dublin 22
4. 22 Shanecastle Cre, Dublin 22
5. 14 St Mary's Rd, Dublin 12 (St = Saint)
6. 3 Main St Upr, Lucan, Co Dublin (St = Street)
7. Apt 4, 26 Shanecastle Grove, Dublin 22 (apartment number is not the house number)
8. Any label with an Eircode on it (the Eircode must win)

## How

- **Page test:** all addresses on one page (A: handwritten, B: printed, C: typed on a laptop screen). Address mode,
  one photo, tap one line, Use address. Repeat for each line.
- **One-by-one test:** one address per photo.
- For each: what went into the field, what the top suggestion was, was it right, and seconds from shutter to field.

## Results

| # | Source (hand / print / screen) | Phone | In the field | Top suggestion | Right? | Seconds |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
