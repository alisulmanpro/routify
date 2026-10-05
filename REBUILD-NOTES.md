# Rebuild notes

Start here if you're picking this project up. It covers what the project is *now*,
what's genuinely still missing, and (at the bottom) how it got here.

## Current state (summary)

- **Rider-only platform.** No organization / team / business-account concept exists
  anywhere. Every rider signs up on their own, gets their own free-trial subscription
  automatically, buys their own plan, and controls their own deliveries. Delivery
  limits are enforced per rider from their own plan.
- **Backend** (`backend/`): Node/Express 5 + Mongoose. JWT auth with rotating refresh
  tokens (reuse of a used token revokes the whole family), bcrypt, roles `rider` and
  `owner_admin`, the full delivery state machine (COD vs prepaid rules, proof photo
  required, failure reasons), PDF manifest import (flags ambiguous payment types for
  human review, never guesses), route planning with geocoding + 2-opt optimization,
  PDF report generation with embedded proof photos, subscriptions/plans/payments
  (SaaS money kept strictly separate from customer COD money), a full admin API,
  audit logging, rate limiting, magic-byte upload validation, HMAC-signed file URLs.
- **Admin web** (`admin-web/`): working pages for Overview, Riders (suspend/reactivate),
  Deliveries, Reports (PDF download), Subscriptions (edit/extend), Plans (edit pricing
  and limits), Payments (record / mark succeeded-failed-refunded against a rider),
  Settings, Audit log. Builds clean.
- **Rider app** (`rider-app/`): Expo/React Native - sign up / login, dashboard, delivery
  list with pending and active-route views, delivery detail (arrive -> camera proof
  photo -> COD cash confirmation -> deliver / fail), manual add, PDF import with an
  editable review step, history, reports, subscription management, account settings.
  Type-checks and bundles clean.
- **Tests:** 15 automated tests (unit + integration against a real MongoDB-compatible
  database), all passing. `cd backend && npm test`.

Docs `01-PRD.md` through `05-backend-schema.md` describe this current state.

## What is genuinely still missing

Ordered by likely importance:

1. **No payment gateway.** "Purchasing" a plan today = the rider requests a plan (a
   *pending* payment record is created), pays the platform outside the app, and an
   admin marks it *succeeded* in the admin console, which activates the plan. There is
   no card entry, automatic charge, webhook handling, or automatic renewal/dunning. If
   riders are expected to pay in-app, a gateway (Stripe, JazzCash, Easypaisa, etc.) must
   be integrated. If the app ships on iOS, Apple generally requires in-app digital
   subscriptions to use Apple In-App Purchase - a policy/legal decision, not just code.
2. **Password reset.** No email service is wired up, so there is no forgot-password
   flow for riders or admins.
3. **Admin can't change their own password** in the admin console (riders can, in the app).
4. **No "end route early".** A route only completes when every stop is delivered or
   failed.
5. **Notifications never fire.** `notificationsEnabled` exists on the user but no
   push/email/SMS is sent.
6. **No live GPS or map view.** Admin sees stop-count progress, not rider location;
   neither app renders a real map (addresses + "open in maps" links only).
7. **No CSV/Excel export** on admin lists.
8. **Deployment/ops:** no Dockerfile/compose, no CI pipeline; file storage is local disk
   (swap `storage.service.js` for S3/GCS before running multiple backend instances).
9. **Automated UI tests:** none for admin-web or the rider app (backend only).
10. **Not verified on a real device.** The rider app's camera capture, file picker and
    touch flows follow Expo's documented APIs and type-check, but were never run on a
    phone/simulator (none was available while building).
11. **Geocoding success path unverified.** The build environment had no outbound
    internet, so geocoding was verified to *fail gracefully* ("location not found"),
    not to *succeed* against real Nominatim/Google. Set a real contact email in
    `GEOCODING_USER_AGENT` (Nominatim's usage policy) and test once deployed.
12. **No offline support** in the rider app - actions fail rather than queue when
    connectivity drops.
13. **Load/performance not tested** - `GET /admin/overview` runs several aggregations
    and should be checked against real data volume.

## How it got here (history)

**Original state.** The backend was four files: three unauthenticated, read-only
endpoints over an in-memory array - no users, auth, routes, reports, subscriptions,
PDF import or file storage, despite all of it being specified in the docs. admin-web
was one hardcoded dashboard screen with placeholder pages behind the sidebar. rider-app
was entirely hardcoded (fake pre-filled login, fake deliveries, no network calls).

**Rebuild.** Everything listed under "Current state" was built and verified by running
it: a live server against a MongoDB-compatible database, real HTTP requests, a real
generated PDF, a compiled admin-web build, and a type-checked, bundled rider app. Two
real bugs were found and fixed by the tests (a tracking-ID regex that rejected short
IDs, and a test-data typo).

**Iteration 2 - organizations made optional (superseded).** Self-signup was changed to
create standalone riders with their own subscription, while admins could still create
optional "team" organizations. This introduced a `tenantId` concept and dual
organization/user ownership on subscriptions and payments. It also surfaced a real bug:
tracking-ID uniqueness keyed on `organizationId` would have made unrelated solo riders
(all `organizationId: null`) collide with each other. **This whole design was replaced
by iteration 3 below - nothing from it remains in the code.**

**Iteration 3 - organizations removed entirely (current).** Per the client, the
organization concept was deleted rather than hidden: the `Organization` and
`OrganizationMember` models, every `organizationId` field, the `tenantId` indirection,
all `/admin/organizations*` endpoints, the add-rider-to-organization flow, the
`ridersPerOrganization` plan limit, and the admin Organizations page are gone.
Tracking-ID uniqueness is now simply `{ riderId, trackingId }`. Verified live:
`/admin/organizations` returns 404 and no API object contains an `organizationId`
field. Tests were updated to assert exactly that, and all 15 pass.
