## Register (`design_pref/Sign up@2x.png` → `rider-app/src/screens/Register.tsx`), 2026-10-20
### Missing in backend / API
- Google sign-in / sign-up endpoint (e.g. `POST /auth/google` taking a Google ID token, returning `{ user, accessToken, refreshToken }`) | needed for: "Continue with Google" button | new route next to `/auth/register`; rider still needs a default currency on first sign-in
### Missing functions / actions
- "Continue with Google" tap | should start Google OAuth (e.g. `expo-auth-session` / Google Sign-In), send the token to the API, then sign in like `register()` does. Rendered disabled for now
### Missing data / fields
- Design logo (dark rounded square with a route curve + blue dot) | no matching asset in `assets/brand/`; drawn with the `vector-curve` icon in `LightBrand` as a stand-in
- Inter font used in the design | app loads no custom fonts; uses the system font
### Extra in app, not in design (kept)
- Confirm password field | `Register.tsx`, under Password (`register()` sends `confirmPassword` and the screen checks it)
- Error banner for failed sign-up / password mismatch | `Register.tsx`, above the fields (restyled light)
- Free-trial / platform-name copy in the subtitle | dropped from the text only; the brand name still comes from `/config` `platformName`
### Notes
- Currency picker removed at the owner's request. Sign-up still sends the `/config` `defaultCurrency` (or USD if `/config` fails). The rider can't choose a currency on this screen.
- The design is light while the rest of the app is dark navy. Added `light` / `lightRadius` tokens in `src/lib/theme.ts` and shared components in `src/components/LightAuth.tsx`; only Register uses them so far.
- The screen sets a dark status bar (`expo-status-bar`) while it is shown. App.tsx still sets the Android status bar background to dark navy; I didn't touch App.tsx.
- Password placeholder uses `/config` `minPasswordLength` (falls back to 8). Added an eye toggle for show/hide, as shown in the design.
- Google "G" on the button is `assets/brand/google-g.png`, a 96px PNG rendered from `design_pref/Vector.svg`. The app has no SVG support (`react-native-svg` isn't installed).
- Login and Forgot password screens are still dark, so switching between Sign in and Sign up now changes theme.

## Login (`design_pref/Login@2x.png` → `rider-app/src/screens/Login.tsx`), 2026-10-20
### Missing in backend / API
- Google sign-in endpoint | needed for: "Continue with Google" button | same as the Register section (`POST /auth/google`)
### Missing functions / actions
- "Continue with Google" tap | should sign in with Google, then behave like `login()`. Rendered disabled (shared `GoogleButton` in `LightAuth.tsx`)
### Missing data / fields
- Design logo (dark square, route curve + blue dot) | no asset; same `LightBrand` stand-in as Register
- Inter font | system font used
### Extra in app, not in design (kept)
- Error banner (wrong credentials / "Could not connect to <API_URL>" message) | `Login.tsx`, above the fields (restyled light)
- Submit from the keyboard ("go" on the password field) | `Login.tsx`, Password field
- Forgot password keeps passing the typed email to the Forgot password screen | `Login.tsx`
### Notes
- The big Routify logo (`assets/brand/routify-logo.png`) and the purple glow are gone from Login, replaced by the design's small brand row. The image file is still in `assets/brand/` but nothing uses it now. `BrandMark` / `BRAND_MARK` are still exported from `Login.tsx` because Dashboard imports `BRAND_MARK`.
- "Sign up" link goes to the existing Register screen (`onGoRegister`); "Forgot password?" goes to the existing Forgot password screen, which is still dark.
- Moved the Google button into a shared `GoogleButton` so Login and Register use the same one.

## Home (`design_pref/Home · Today@2x.png`, `Home · No route@2x.png`, `Home · Tomorrow@2x.png` → `rider-app/src/screens/Dashboard.tsx`), 2026-10-20
### Missing in backend / API
- Per-route count of unverified stops in `GET /routes/by-date` (`RouteListItem`) | needed for: the "2 unverified" pill on a route row | add e.g. `unverified: number` to each item
### Missing functions / actions
- "Edit stops" for a whole day (Tomorrow view) | should open one place to edit every stop planned for that day. There is no such screen yet, so with exactly one route it opens that route's detail; with several routes it's disabled
### Missing data / fields
- "2 unverified" status pill | `RouteListItem` has no unverified count; the row shows the route's status pill instead
- Box illustration on "No route for today" | no illustration asset; drawn with the `package-variant-closed` icon plus a ground line and blue dashes
- Rider avatar photo | none in the API; shows the first letter of the rider's first name, as in the design
### Extra in app, not in design (kept)
- Left-over stops from earlier days with a "Move" button | Dashboard, under the day chips (restyled light)
- Subscription nudge (`PlanNudge`) | Dashboard, under the header (still its own dark style)
- Error banner and pull-to-refresh | Dashboard
- Failed count | appended to "delivered today" as "· N failed" when there are any
- Start route / Plan route · N stops / View planned route / View route map | the main button under the progress bar changes with today's state. The design only shows "Continue route"
- Picking any day on the calendar | the calendar button opens the existing `DatePicker` inline; the picked day gets a chip even before it has a route
### Notes
- Removed the old dashboard extras the design drops: the "Deliver more, earn more" hero card, the Progress/Delivered/Failed stat cards, "Route completion" card and "Today's totals" list. Their numbers still show as "5 / 7 delivered today", the progress bar, failed count and per-route km, and the map is reachable from the main button and each route's detail.
- Settings gear opens the existing Account tab (`switchTab('account')`).
- "+ New route" and "Plan a route" open the existing New route screen for the selected day.
- The bottom "Tomorrow · <route>" card shows on Today: the first route on the next day that has routes. It opens that route's detail.
- The bottom tab bar and the safe-area band above the header are drawn by `App.tsx`, which is still dark navy. I didn't touch it (navigation), so Home is light between a dark top strip and a dark tab bar until App.tsx's tab bar is restyled. The status bar stays light for the same reason.
- `DatePicker` and `PlanNudge` are dark components used by other screens too, so I didn't restyle them; the calendar sits in a dark rounded panel.
- `src/components/LightAuth.tsx` was renamed to `src/components/LightKit.tsx` (it now also holds `LightPill` and `LightProgress`). The Register and Login sections above still say `LightAuth.tsx`.
- The 14-day free trial is not on this screen, by request.

## Home follow-up: shell, calendar, free trial (`design_pref/Home · *@2x.png` → `rider-app/App.tsx`, `src/components/DatePicker.tsx`, `src/components/PlanNudge.tsx`, `src/screens/Dashboard.tsx`), 2026-10-20
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- Free trial / Upgrade chip at the top right of the Home header (owner's request, not in the design) | `PlanNudge.tsx`, rendered next to the gear. It replaces the dark "Start your 14-day free trial" card; it opens a light modal whose button goes to Paywall (or Subscription when no store is available), as before
- "Not now" and ✕ in that modal | close it without navigating
### Notes
- Bottom tab bar is now light on every tab (white, grey icons, blue active icon and label, no pill), per the design. Reports icon changed to a bar chart. The screens behind History, Reports and Account are still dark until they're redesigned.
- The strip behind the status bar (and the Back bar) is light only on screens in `LIGHT_SCREENS` in `App.tsx` (just `Dashboard` for now); add a screen's name there when it's redesigned. The status bar icons follow it (dark on light, light on dark).
- `DatePicker` has a new `light` prop: white card, black selected day, blue ring on today, no orange/yellow. New route still uses the dark version.
- The round gear floating at the very top right in dev builds is Expo's dev-menu button, not app UI; it doesn't ship in release builds.

## Home empty-state illustration (owner-supplied SVG → `rider-app/src/screens/Dashboard.tsx`), 2026-10-20
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- "No route for today" now shows the owner's box SVG as `assets/brand/empty-route.png` (504×384, rendered at 3× and shown at 168×128). It replaces the icon + line + dashes drawn in code. The app has no SVG support, so it's a PNG.

## Home: day chips and calendar removed, unplanned next-day stops (`rider-app/src/screens/Dashboard.tsx`), 2026-10-20
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- "<Day> · N stops added / Not planned yet" card at the bottom of Home | Dashboard. Shows stops saved for a later day that never became a route; tapping opens the existing Review route screen for them (same as "Done · review" on Add stops)
### Notes
- Removed by owner's request: the Today / Tomorrow / date chips and the calendar button. Home now always shows today. The Tomorrow view (`Home · Tomorrow@2x.png`: "2 routes", "Edit stops") is no longer reachable; later days show only as the bottom card(s). The "Edit stops" MISSING item in the Home section above no longer applies.
- Cause of "tomorrow's route doesn't show": the 3 stops for 21 Oct were saved, but "Plan route on the map" on Review route never ran, so no route existed. Home only listed routes. The new card covers that case.
- `DatePicker`'s `light` prop is now unused (Home was its only user); kept in case a light screen needs the calendar.

## Home: one card style for every day, "New route" as the main button (`rider-app/src/screens/Dashboard.tsx`), 2026-10-20
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request: removed the "Routes · + New route" list under the button. Today's routes now use the same card as the next day's ("Today · <name> / 2 stops · In progress"). Tapping a card opens that route's detail screen.
- The main button under the progress bar is always "New route", which opens the New route screen for today. It replaces Continue route / Start route / Plan route / View planned route / View route map. Continuing or starting a route, and its map, are now reached from the route's detail screen via its card.
- Today's stops that aren't in a route get the same "N stops added · Not planned yet" card as later days, opening Review route.
- The route status pills (In progress / Completed / Planned) are gone with the list; the status is now text in the card.

## Add stops (`design_pref/Add stops@2x.png` → `rider-app/src/screens/AddStops.tsx`), 2026-10-20
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- Route name · day line under the "Add stops" title | AddStops header
- Parcel ID field (with barcode scan) and the "Add stop" button | AddStops, under the search field. They appear once something is typed in the field; the keyboard's Done also adds the stop
- Clear (✕) and the searching spinner in the search field | AddStops search field
- Address suggestions list, the "couldn't pin this address" box (Drop pin / Add anyway), error banner | AddStops, under the search field (restyled light)
- Voice panel when Voice is on | AddStops, under the Scan/Voice/Pin/Import row
- Parcel ID / customer name after "Location confirmed" on a stop | `StopLines`
- Bottom tab bar | App.tsx shell; the design shows only the "Review N stops" footer
### Notes
- Only the UI changed. The add, duplicate, scan, geocode, pin, voice, import and remove logic in AddStops is unchanged (the one new line is `goBack` for the back arrow).
- The design's back arrow is in the screen. `App.tsx` now hides its dark "‹ Back" bar on light screens (`LIGHT_SCREENS`: Dashboard, AddStops); Android's back button still works.
- `StopLines` has a new `light` prop (bigger Eircode, grey address, green ✓ "Location confirmed"). Review route and Route detail still use the dark version.
- Still dark, not restyled (shared scan/add-stop flows and other screens): Eircode scanner, barcode sheet, Pin sheet, Import sheet, the voice panel's own controls, the "Already in your stops" and "Stop added · Scan next" prompts, and the "Remove this stop?" system alert.
- "Review N stops" opens the existing Review route screen, which is still dark.

## Onboarding (`design_pref/Onboarding 1 · Location@2x.png`, `Onboarding 2 · Camera@2x.png`, `Onboarding 3 · Notifications@2x.png` → new `rider-app/src/screens/Onboarding.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- Notifications on iOS | needs `expo-notifications` (not installed). The notifications page is skipped on iOS for now
- Sending notifications at all | the app sends no route alerts yet; this only asks for the permission so it's ready
### Missing data / fields
- Illustrations (pin with ground rings, camera with scan corners, bell with dot and sound arcs) | no assets; drawn with Ionicons plus blue accents. Send SVGs like the empty-route box and I'll swap them in
### Extra in app, not in design (kept)
- None
### Notes
- New screen, created at the owner's request (there was no onboarding before). It shows once per device after sign-in, before Home (flag `dp_onboarding_done_v1` in AsyncStorage), from `Gate` in `App.tsx`. It isn't a tab screen.
- One page per permission, each asked on its own when "Allow" is tapped: location (`expo-location`, while using the app), camera (`expo-camera`; the same OS permission covers the Eircode scanner, barcode scan and proof photos), notifications (Android 13+ via `PermissionsAndroid`; Android 12 and older grant it at install).
- Pages for permissions that are already granted are skipped, and the dots only count the pages shown. If everything is granted, onboarding ends straight away.
- "Not now" moves on without asking. Each feature still asks for its permission when it's used, as before.
- If a permission was denied with "Don't ask again", "Allow" opens the app's system settings instead, then moves on.
- Added `android.permission.POST_NOTIFICATIONS` to `app.json`. The Android app must be rebuilt (`npx expo run:android` or a new EAS dev build) for the notifications page to work.
- Permission helpers are in `src/lib/permissions.ts`.

## Add stops: two scan buttons, two behaviours (`rider-app/src/screens/AddStops.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request. The scan icon inside the "Eircode or address" field now only reads the Eircode and puts it in the field. Adding that stop doesn't show "Stop added · Scan next".
- The Scan button in the Scan / Voice / Pin / Import row keeps the batch flow: after the scanned stop is added, "Stop added · Scan next" asks whether to scan the next parcel. "Scan next" reopens the scanner in the same batch mode.
- Both still run the duplicate check ("Already in your stops") as soon as an Eircode is read.

## Home: unfinished stops card reopens Add stops (`rider-app/src/screens/Dashboard.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request. The "<Day> · N stops added" card (stops saved but never confirmed into a route) now opens Add stops for that day instead of Review route. Add stops already lists every unconfirmed stop for the day, so the rider can add more, then tap "Review N stops" to plan.
- That card has a red border and light red background, a red pencil icon and the text "Not finished. Tap to keep adding stops", so it stands out as work in progress. New tokens: `light.dangerBg`.
- The route name comes from what was typed on New route for that day (remembered per day), or the default "Route · <date>".
- Removed the temporary `[scan-debug]` logs from AddStops.

## Confirm stop, Stop added, Already in your stops (`design_pref/Confirm stop@2x.png`, `Confirm stop · Verifying@2x.png`, `Stop added (modal)@2x.png`, `Already in your stops (sheet)@2x.png` → new `rider-app/src/components/scan/ConfirmStop.tsx`, `ConfirmMap.*`, `src/components/StopPrompts.tsx`), 2026-10-21
### Missing in backend / API
- None (uses the existing `POST /deliveries/geocode-check` and `POST /deliveries/manual`)
### Missing functions / actions
- None
### Missing data / fields
- Address while "Verifying location…" | the design shows the full address during verifying; the app only knows it once the Eircode lookup answers, so it shows "Looking up the address…" until then
### Extra in app, not in design (kept)
- Barcode scan icon in the Parcel ID field | Confirm stop (opens the existing barcode scanner)
- "Approximate location" (amber) and "Location not found" (red) chips, with "Add anyway" when the Eircode isn't found | Confirm stop. The design only shows "Not confirmed yet" and "Location confirmed"
- "Try again" button and an error message when the lookup fails (no connection) | Confirm stop
- Distance duplicates ("Within a few metres of stop #N") | Already in your stops; the design only shows the same-Eircode text
### Notes
- Owner's request, built without check-ins (owner away). Only the Scan button under the field uses this flow: Scan → Confirm stop "Verifying location…" (grey button, "Not confirmed yet") → "Location confirmed" + Add stop → "Stop added" pop-up with Scan next (opens the scanner again) or Done (back to Add stops). Rescan reopens the scanner; the back arrow returns to Add stops.
- If the scanned Eircode is already on the list, "Already in your stops" opens over the confirm screen straight away: View stop (back to Add stops, scrolls to it and highlights it), OK (back to Add stops) or Add anyway (a second parcel for the same door; then Add stop works).
- The scan icon inside the "Eircode or address" field still only fills the field (unchanged); its duplicate warning now uses the new light "Already in your stops" sheet.
- Real Google map (`react-native-maps`, already installed) with a light, POI-free style, a blue pin and a soft halo. Web shows a plain panel.
- Confirm stop is a full-screen sheet inside Add stops (like the scanner and Pin sheets), not a new navigation route.
- The old dark "Stop added ✓ / Scan next / Cancel" prompt is gone; the light "Stop added" card replaces it.
- Saving goes through the same `createStop` as every other path (same duplicate rules, same Eircode point handling).
- Not tested by tapping on the phone (adb can't tap on this MIUI phone). Lint, type-check, unit tests and the Metro Android bundle all pass.

## Eircode "Approximate location" fix + white scan frame (`backend-py/app/services/geocoding_service.py`, `rider-app/src/components/scan/EircodeScanner.tsx`, `BarcodeSheet.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request (this one does touch the backend). Every scanned Eircode said "Approximate location" even with the right address. Cause: Google returns every full-Eircode match as location_type "APPROXIMATE" (result type `postal_code`), checked live for D15 N7DC, A63 P489 and K67 W2H7. The backend flagged anything that wasn't "ROOFTOP" as approximate.
- Fix: a full Google Eircode match (the postcode equals the scanned Eircode) now counts as found, matching the backend's existing rule that an Eircode is one building. Ordinary addresses keep their own rule. The Eircode cache key moved to `v4`, so older "approximate" cache entries are looked up again (cost: one fresh Google lookup per Eircode).
- Stops saved before the fix keep "Approximate location" in their card until the route is planned; planning re-checks approximate stops and updates them.
- Scanner frames (Eircode and barcode) are white instead of orange while looking. The Eircode frame still turns green when an Eircode is locked and amber when the reading is unclear. The loading spinner and "Type it instead" are white; the torch-on icon is pale yellow.

## Separate routes on the same day (`backend-py/app/services/route_service.py`, `tests/test_api.py`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's bug: planning a new route ("New Assignment") deleted yesterday's not-yet-started "Tomorrow's Work" for the same day and merged its 5 stops into the new one. Cause, two steps: `build` released every planned route of the day before building, then the route map auto-ran `optimize`, which pulled in every loose stop of that day ("new stops").
- Fix: `build` with chosen stops only takes those stops and leaves other routes of the day alone (a chosen stop still on another unstarted route moves over; that route is removed only if it ends up empty). `optimize` only re-orders the route's own stops; `newStops` is always 0. Move (carry-over) now makes the moved stops a route of their own, named after their old route, instead of merging them into today's route.
- Planning a whole day without chosen stops (API only; the app no longer does this) still replaces that day's unstarted route.
- Tests: new `test_a_new_route_never_takes_or_removes_another_route_of_the_same_day` passes, and so do carry-over and optimize. `test_optimize_…` was updated to the new behaviour. Three other route tests fail with the test environment's 503 "address lookup unavailable" or an Eircode-pattern assertion; they fail the same way on the original code.
- Data repaired for the owner's account on 2026-10-21: "Tomorrow's Work" rebuilt with its 5 stops (311.6 km), and "New Assignment" re-optimised with its own 4 stops (121.5 km).

## New route (`design_pref/New route · B Tiles@2x.png` → `rider-app/src/screens/NewRoute.tsx`), 2026-10-21
### Missing in backend / API
- Route start point | needed for: START POINT "Change" | add an optional `origin` the rider picks (map pin / address) and send it to `POST /routes/build` instead of the GPS position
- Copy stops from another route | needed for: "Copy stops from a previous route" | e.g. `POST /routes/{id}/copy-stops` with a target date, creating new pending stops for that day
### Missing functions / actions
- START POINT "Change" | should let the rider choose where the route starts (pin or address). Rendered disabled
- "Copy stops from a previous route" | should list earlier routes and copy their stops into this new route's day. Rendered disabled
### Missing data / fields
- None
### Extra in app, not in design (kept)
- "<route> is still underway" notice when today has an active route | NewRoute, under the day tiles (restyled light)
- Error banner when the current route can't be checked | NewRoute, under the subtitle
- Picking a later date: the Pick tile turns black and shows that date ("Picked · 25 · Sat") once chosen; tapping it again reopens the calendar
### Notes
- Day tiles: Today / Tomorrow / Pick (opens the light calendar). The chosen date shows under them ("Thu, 22 Oct").
- The route-name placeholder is the existing default name the route gets when left blank ("Route · Thu, Oct 22"), not the design's "Thu 22 Oct route", so the placeholder matches what is saved.
- Removed the old "<route> is already planned for this day — planning a new route replaces it" warning: after the 2026-10-21 fix a new route never replaces another one, so it was no longer true.
- "Continue to stops →" is a fixed footer button; it opens Add stops as before (and remembers the name for that day).
- Added `NewRoute` to `LIGHT_SCREENS` in `App.tsx` (light top strip, its own back arrow; Android back still works).

## Review stops (`design_pref/Review stops@2x.png` → `rider-app/src/screens/RoutePreview.tsx`), 2026-10-21
### Missing in backend / API
- Manual stop order | needed for: "Drag to reorder" and the drag handles | `POST /routes/build` always orders the stops itself; it would need to accept a fixed order (e.g. `order: deliveryId[]` with `preference: "manual"`)
- Distance and time before planning | needed for: "approx 32 km · 1 h 40 min" | e.g. `POST /routes/estimate` with the stop ids, returning km and minutes without saving a route
### Missing functions / actions
- Drag to reorder | long-press a stop and drag it to a new place in the list. Handles are shown but don't move anything
### Missing data / fields
- "approx 32 km · 1 h 40 min" | not known until the route is planned; shows "approx — km · —"
### Extra in app, not in design (kept)
- Route name · day line under the stats | Review stops header
- Route type (Smartest / Nearest first / Most efficient) | moved behind "✨ Optimise route", which opens a light bottom sheet; the choice is used when the route is planned, as before
- "Approximate location" (amber) and "Location not found" (red) tags, besides the design's "Location not verified" (amber, stops not looked up yet)
- Error banner | under the list
### Notes
- Removed the inline map and the "N stops are not pinned exactly yet" note; "Preview route" plans the route and opens the full route map, as "Plan route on the map" did before. Verified stops show no tag, like the design.
- "Add or remove stops" link removed; the back arrow returns to Add stops, which does the same.
- `plan()` (POST /routes/build with the chosen stops and route type) is unchanged.
- Added `RoutePreview` to `LIGHT_SCREENS` in `App.tsx`.

## Route detail replaced by Review stops (`rider-app/src/screens/RouteDetail.tsx` removed → `RoutePreview.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- Stop status tags on an existing route: Delivered (green), Failed (red), Arrived (blue); pending stops keep the location tags
- Tapping a stop opens its delivery screen (as the old route detail did)
- Route state in the small line under the stats ("Assignment · Today · Planned")
### Notes
- Owner's request. Tapping a route on Home (and opening the route made by Move) now opens Review stops for that route instead of the old route detail screen, which is deleted. The old `RouteDetail` navigation name still maps to Review stops, in case anything links to it.
- For an existing route, the header shows its real distance and time ("4 stops · approx 413.89 km · 22 h 17 min"), and the stops are in route order.
- "Preview route" opens that route's map. Start route / Start navigation live there, so navigation is one tap further than on the old screen (it had them on the detail page itself).
- "✨ Optimise route": a planned route opens the route-type sheet, and picking another type plans the same stops again that way (the route gets a new id; the old empty one is removed). A running route re-orders its open stops from the rider's position. Hidden on a completed route, which also shows chevrons instead of drag handles.
- The old screen's stats card (Stops / Delivered / Distance / Duration) is now the stats line; Delivered shows as the per-stop tags.

## Route preview (`design_pref/Route preview@2x.png` → `rider-app/src/screens/RouteMapScreen.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- "Edit stops" as a real stop editor (add/remove stops on a planned route) | there is none; it opens Review stops for this route (stops, status, route type, tap a stop to open it)
### Missing data / fields
- None
### Extra in app, not in design (kept, owner's request: "keep the rest of the current screen")
- Route name, day, route type and state line | under the buttons
- "Ordered using road distances…" note and "✨ Optimise from here" | under the route name
- The stop list (start point, numbered stops with leg distance/time, Next/Pending tags, Directions, Open delivery, Set pin, Route complete, Completed section) | below the buttons
- Pin placing bar (Cancel / Save pin) over the map | when a stop is being pinned
- Fit-to-route button on the map (top right) | map
- Collapsing map while the list scrolls; pull-to-refresh
### Notes
- Design part: light map with blue numbered pins, the last stop black, blue route line, a floating back button, a bottom sheet with big stats and "Start route" + "Edit stops".
- Stats: a planned route shows the whole route (stops · distance · est. time); a running one shows what is left (stops left · left to drive · remaining); a completed one shows stops done and its distance.
- Main button: planned → "Start route" (or "Start now (planned for tomorrow)"); running → "Start navigation"; completed → none. Same actions as before.
- `GoogleRouteMap` has a new `light` prop and a `last` pin kind; Live Navigation and the Pin sheet keep the dark map. The light map style now lives in `src/lib/mapStyles.ts`, shared with Confirm stop.
- `LightPill` gained a `red` tone (Failed). Added `RouteMapScreen` to `LIGHT_SCREENS` (its own back button replaces the dark Back bar).
- Logic unchanged apart from marking the last stop's pin.

## Route preview follow-up: steady map, no "Optimise from here" (`rider-app/src/screens/RouteMapScreen.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request. The map no longer shrinks while scrolling (the resize animation made it jump). It keeps half the screen; the whole page scrolls, so dragging the bottom sheet up moves it smoothly and carries the map off the top. The back button stays fixed.
- While a finger is on the map, the page doesn't scroll, so the map can be panned and zoomed. Placing a pin scrolls back to the map and locks the page until the pin is saved or cancelled.
- "Optimise from here" removed. The "Ordered using road distances and times." line stays. Saving a pin still re-orders the route as before. The location-denied hint now says "so your position shows on the map".

## Stop detail + Failed delivery (`design_pref/Stop detail@2x.png`, `Failed delivery@2x.png` → `rider-app/src/screens/DeliveryDetail.tsx`), 2026-10-21
### Missing in backend / API
- "Can't access building" failure reason | needed for: Failed delivery list | the API's reasons are customer_unavailable, customer_refused, wrong_address, phone_unreachable, business_closed, other; add e.g. `no_access`
### Missing functions / actions
- Copy Parcel ID button | no clipboard library (`expo-clipboard` isn't installed). The icon shows disabled; the Parcel ID can be long-pressed and copied
### Missing data / fields
- None
### Extra in app, not in design (kept)
- "Open in Google Maps" link and the "approximate / not found" warning | under the address
- Customer name, phone and call button | when the stop has a customer
- "Add proof photo" row (take or choose a photo) for Delivered | above the buttons while the stop is open
- Delivered / Failed result with time, failure reason and note, and the proof photo | once the stop is done
- "Delete delivery" | pending stops only
- "Earlier delivery still open — continue anyway?" check before Delivered | unchanged
- Reasons "Phone unreachable" and "Business closed" | Failed delivery list (the API has them; the design shows "Can't access building" instead)
### Notes
- Opened by "Open delivery" on the route map and by tapping a stop in Review stops. Delivered / Failed are fixed at the bottom while the stop is open.
- No more "Mark arrived" step: the server only accepts a result or a photo after Arrived, so Delivered, Failed and Add photo mark a pending stop arrived first (the existing `/arrive` call), then run. Same server rules: the route still has to be started.
- Failed delivery is a full-screen step: pick a reason, an optional note (required for "Other", as the API asks), an optional photo, then Confirm (grey until a reason is picked). ✕ goes back to the stop.
- The map is the light map with the stop's pin (shared with Confirm stop); "Not on the map yet" when the stop has no location.
- Added `DeliveryDetail` to `LIGHT_SCREENS`.

## Proof of delivery + Route complete (`design_pref/Proof of delivery@2x.png`, `Proof of delivery · Filled@2x.png`, `Route complete@2x.png` → `rider-app/src/screens/DeliveryDetail.tsx`, new `src/screens/RouteComplete.tsx`), 2026-10-21
### Missing in backend / API
- Signature | needed for: Proof of delivery "Signature" box | an upload for a signature image (e.g. `POST /deliveries/{id}/signature`) and a field to keep it; shown disabled at the owner's request
- Separate delivery note | needed for: Proof of delivery "Note" | `POST /deliveries/{id}/deliver` saves `note` into the stop's own note, replacing the "Notes" shown on Stop detail; a separate `deliveryNote` field would keep both
### Missing functions / actions
- Signature pad and Clear | draw and clear a signature (needs a drawing component, e.g. react-native-signature-canvas, plus the API above)
### Missing data / fields
- None
### Extra in app, not in design (kept)
- "Choose from gallery" under the photo | Proof of delivery
- "—" for Distance / Time on Route complete when the route has no planned distance or start/finish times
### Notes
- Owner's request. Stop detail → Delivered opens Proof of delivery: Take photo (camera) or Choose from gallery; once added, the photo shows with "Photo added · time" and Retake; optional note; Complete delivery (same "earlier stop still open?" check as before). The photo is optional, as before.
- Stop detail → Failed opens Failed delivery (built in the previous change).
- Route complete is a new screen (`RouteComplete` in App.tsx's screen list, light). It opens when a Delivered or Failed finishes the route's last open stop (the server completes the route by itself), from Stop detail and from Live Navigation's quick Delivered. It shows delivered, failed, distance and time (start to finish), each failed stop with its reason (tap opens it), and Back to home.

## Active delivery (`design_pref/Active delivery@2x.png` → `rider-app/src/screens/LiveNavigation.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- Next-turn banner ("20 m · Turn left onto …", "You have arrived") from the in-app guidance | under the "Stop N of M" pill, restyled white
- "Then: <next stop>" line | under the buttons
- "Allow location access for live guidance" hint and the "no map location" warning
- "See summary" on a finished route (opens Route complete)
### Notes
- Light map with every stop: finished ones grey with their number, the stop being driven to black, the rest blue (new `current` pin kind; light `done` pins are grey). Live position and the road line as before.
- "Stop N of M" pill; ☰ opens Review stops for this route (all stops and their status). The document button opens Stop detail.
- Navigate opens voice directions in Google Maps (the old "Voice directions in Google Maps" button).
- Delivered and Failed now open the Proof of delivery and Failed delivery steps (Stop detail opens straight on that step via a new `step` param; back returns here). Before, Delivered here was one tap with no proof. Finishing the last stop opens Route complete; otherwise coming back reloads the route on the next stop.
- `markDelivered` in `src/lib/deliveryActions.ts` is no longer used by any screen; left in place.
- Added `LiveNavigation` to `LIGHT_SCREENS`. GPS, routing and turn-instruction logic unchanged.

## Home states (`design_pref/State · Loading@2x.png`, `State · Error@2x.png`, `State · Offline@2x.png` → `rider-app/src/screens/Dashboard.tsx`), 2026-10-21
### Missing in backend / API
- Offline queue / sync | needed for: "changes will sync later" and "2 updates waiting" | the app has no offline storage or queued actions; deliveries marked while offline fail with an error. Would need a local queue (e.g. AsyncStorage) replayed when back online
### Missing functions / actions
- Live network status | no NetInfo / expo-network installed; "offline" means the last Home load couldn't reach the server (fetch failed). It clears on the next successful load (pull to refresh, Try again, tapping the banner, or coming back to Home)
### Missing data / fields
- "2 updates waiting" | no queue (see above); not shown
### Extra in app, not in design (kept)
- None
### Notes
- Loading: the header (from the signed-in rider) and grey pulsing placeholders shaped like Home, instead of a spinner.
- Error (first load failed): the header, a cloud with a red "!" in a light red circle, "Something went wrong", "We couldn't load your routes. Check your connection and try again." (or the server's own message), and Try again.
- Offline (a reload failed after Home had loaded): the last data stays on screen, a yellow banner at the top, the header says "Offline" with a grey dot, and "Last synced HH:MM" under the cards. The banner reads "You're offline — reconnect to update" rather than the design's "changes will sync later", because nothing is queued (see above). Tapping it tries again.

## Splash (`design_pref/Splash · B Dots@2x.png` + owner-supplied SVG → `rider-app/src/components/AnimatedSplash.tsx`, `app.json`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- "Waking up the server…" | under the dots, after 5 s (the free API server can be slow to wake)
### Notes
- White background, the owner's pin mark (`assets/splash-mark.png`, 384×384, rendered at 4× from the SVG, shown at 96), "Routify", "PLAN · DELIVER · TRACK", three blue dots that light up in turn, and the app version (from app.json, "v1.0.0") at the bottom. Checked on the phone.
- The native splash in `app.json` now uses the same mark at 96 wide on white, so the hand-off is seamless. That only takes effect after a rebuild (`npx expo run:android`); until then the old dark native splash shows for a moment first. In dev builds Expo's grey "Loading from …" screen also shows before it; release builds don't have that.
- The blank view behind the splash while the session restores is now white instead of navy.
- `assets/splash-icon.png` (the old mark) is no longer used by the splash.

## Location sheet + Choose delivery area (`design_pref/Location sheet · B Map-led@2x.png`, `Choose delivery area (sheet)@2x.png` → `rider-app/src/lib/serviceArea.tsx`), 2026-10-21
### Missing in backend / API
- Recent delivery areas | needed for: the history rows ("Dublin 15", "Bray, Co. Wicklow"…) on Choose delivery area | the API keeps only the current area; a list of the rider's recent areas (e.g. `GET /rider/service-area/recent`) would fill it
### Missing functions / actions
- None
### Missing data / fields
- Recent areas list | shows the area saved now ("Current area") instead, when it differs from the detected one
### Extra in app, not in design (kept)
- "(Now set to <city>.)" after the location sheet's text | which area it would replace
- "No places found" when a search has no results; a clear (✕) button in the search
### Notes
- Same trigger as before (on launch and every few hours, when the rider is in a different city from the saved one). Now a light bottom sheet: a small map with the rider's pin and a "NEW LOCATION DETECTED" badge, "You're in <city>", "Yes, deliver in <city>" (saves it, as before), "Other area" and "Not now" (as before: asks again later).
- Other area opens Choose delivery area in the same sheet: "Use current location" (the detected city, picked by default), the saved area, and search results for a town, county or Eircode (the existing `/deliveries/geocode-suggest`, near the rider). Confirm area saves the chosen point with the existing `PUT /rider/service-area`; the server works out the area from it. Tapping outside or Back returns from the picker to the location sheet.

## Home: completed routes hidden (`rider-app/src/screens/Dashboard.tsx`), 2026-10-21
### Missing in backend / API
- None
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request. Completed routes no longer show as cards on Home (today's or the next day's). They are still in History, and their stops still count in "N / M delivered today" and the failed count.

## Route preview: Edit stops opens Add stops (`rider-app/src/screens/RouteMapScreen.tsx`, `AddStops.tsx`, `App.tsx`), 2026-10-21
### Missing in backend / API
- Editing a started route's stops | a route that is underway can't be planned again (`ROUTE_ACTIVE`), so Edit stops only shows on planned routes
### Missing functions / actions
- None
### Missing data / fields
- None
### Extra in app, not in design (kept)
- None
### Notes
- Owner's request. Edit stops on a planned route's map opens Add stops (new `routeId` param) with that route's stops on the list, plus any unconfirmed stops for that day. The rider can add (type, scan, pin, import) or remove stops; "Review N stops" then plans the route again with exactly that list. The rebuilt route replaces the old one (its stops move over and the empty old route is removed, per the 2026-10-21 route fix).
- Removing a stop there deletes it (pending stops only, as before) and takes it off the route.
