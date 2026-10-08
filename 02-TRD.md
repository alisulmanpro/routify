# Delivery Planner - Technical Requirements Document (TRD)

> Status: reflects the platform as actually built and verified (live server, real
> HTTP requests, automated test suite - not aspirational). Where something described
> in an earlier draft was never implemented, it's called out explicitly below rather
> than left in as if it exists.

## 1. Architecture
- Rider Mobile: React Native + Expo (custom lightweight in-app router; not Expo
  Router - see `rider-app/AGENTS.md`).
- Admin Web: React + TypeScript + Vite.
- Backend: Node.js + Express 5.
- Database: MongoDB + Mongoose.
- REST API: `/api/v1`.
- Authentication: JWT access tokens (short-lived) + rotating refresh tokens with
  reuse detection (replaying a used refresh token revokes its whole token family).
- Password hashing: bcrypt.
- **Not implemented:** Socket.IO / any real-time transport. Admin and rider clients
  poll on demand (screen focus, pull-to-refresh) rather than subscribing to live
  updates. SMS/OTP and a payment-gateway integration are also not implemented -
  subscription payments are recorded and confirmed manually by an admin today (see
  `05-backend-schema.md` Payments and the project's "what is missing" notes).

## 2. Supporting Services
- **Object storage:** local disk by default (`backend/uploads/`), abstracted behind
  `storage.service.js` so it can be swapped for S3/GCS without touching callers.
- **PDF parsing:** `pdf-parse` for reading a manifest's text content.
- **PDF generation:** `pdfkit` for daily reports, with embedded proof photos.
- **Geocoding:** Nominatim (OpenStreetMap, free/rate-limited) by default, or Google
  Geocoding with an API key; results are cached per rider city. Each rider has a
  service area (their delivery city, detected from GPS or typed in Account) and every
  lookup is scoped to it: the full address is searched inside a 35 km radius first,
  then anywhere in the rider's country (flagged approximate if it lands outside the
  city), and short locality fallbacks only ever match inside the city. Provider errors degrade to a "location
  not found" flag rather than blocking route building.
- **Logging:** `pino` / `pino-http`, structured JSON, secrets redacted.
- Email/SMS and a payment provider are **not wired up** - see Section 1.

## 3. Backend Architecture
Routes (thin, per `modules/*/*.routes.js`) -> Services (`services/*.service.js`,
where all business logic lives) -> Mongoose models -> MongoDB. There is no separate
repository layer; Mongoose models are queried directly from services.

Cross-cutting concerns: authentication and authorization middleware, Zod request
validation, a centralized error handler with a consistent JSON error shape, rate
limiting, multipart file upload with magic-byte content validation, HMAC-signed
private file URLs, and an audit log for sensitive admin actions.

## 4. Roles
- `rider`
- `owner_admin`

There is no tenant/organization scoping of any kind. Every rider-owned record
(deliveries, routes, reports, subscription, payments) is scoped directly by that
rider's own `riderId`/`userId` - nothing more, nothing shared. A rider can only ever
see and act on their own data; `owner_admin` can see everything.

## 5. Core Entities
`User` (role `rider` | `owner_admin`), `RefreshToken`, `Delivery`, `Route`, `Report`,
`Plan`, `Subscription`, `Payment`, `AuditLog`, `Setting`, `GeocodeCache`.

There is no `Organization`, `OrganizationMember`, or `DeliveryGroup` entity - these
were considered in an earlier draft of this platform and explicitly removed. A
`Subscription` and a `Payment` each belong to exactly one `User` (`userId`), never to
anything else.

## 6. Delivery Requirements
A delivery needs a **parcel ID** (stored as `trackingId`) and an **address**. Customer
name, phone and note are optional - a scanned label often has only the address and
parcel ID. Deliveries carry **no payment details**: prepaid/COD was removed in Oct 2026.
Older records may still hold a legacy `payment` object; it is ignored and never
returned by the API.

Rules (enforced in the `Delivery` model's own validation, not just in the API layer):
- Marking a delivery `failed` requires a failure reason; reason `other` requires a
  note.
- Parcel IDs are unique per rider (`{ riderId, trackingId }`), not globally - two
  unrelated riders can use the same parcel ID without conflict.

## 7. API Reference (as implemented)
All routes are mounted under `/api/v1`. `authenticate` requires a valid bearer
access token; `authorize('rider')` / `authorize('owner_admin')` further restrict by
role.

**Auth** (`/auth`)
```
POST   /auth/register            self-service sign-up (always creates an independent rider)
POST   /auth/login                { email, password, client: 'mobile' | 'web' }
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me                   auth required
PATCH  /auth/me                   auth required - profile/currency/route-preference/notifications;
                                  `city` sets the delivery city by name, `null` clears it
POST   /auth/change-password      auth required
```

**Config** (`/config`) - public, no auth
```
GET    /config                    currencies, default currency, min password length, platform name/support/privacy/payment-instructions
```

**Deliveries** (`/deliveries`) - rider only
```
POST   /deliveries/import/pdf     multipart 'file' - returns a reviewable draft, never auto-creates
POST   /deliveries/manual
POST   /deliveries/bulk           create many at once (used after PDF review)
GET    /deliveries                filters: status, date, dateFrom/dateTo, search, sort
GET    /deliveries/:id
PATCH  /deliveries/:id            only while status = pending
DELETE /deliveries/:id            only while status = pending
POST   /deliveries/:id/arrive
POST   /deliveries/:id/proof      multipart 'photo'
POST   /deliveries/:id/deliver
POST   /deliveries/:id/fail
```

**Routes** (`/routes`) - rider only
```
POST   /routes/build              { preference?, origin?, deliveryIds?, date? }
GET    /routes/current            the rider's active or most recent planned route
GET    /routes                    completed routes
GET    /routes/:id
POST   /routes/:id/start
```

**Rider dashboard** (`/rider`) - rider only
```
GET    /rider/dashboard           ?date=YYYY-MM-DD (defaults to today)
GET    /rider/history             per-day rollup across all history
GET    /rider/service-area/detect ?latitude&longitude - city at a GPS point (not saved)
PUT    /rider/service-area        {latitude, longitude} - save the detected city as the delivery city
```

**Reports** (`/reports`) - rider only
```
POST   /reports/generate          { date? } - generates/regenerates that day's PDF
GET    /reports                   the rider's own reports
GET    /reports/:id
```

**Subscriptions** (`/subscriptions`) - rider only
```
GET    /subscriptions/me          subscription + plan + all plans + usage
POST   /subscriptions             { planKey, billingCycle } - requests a plan change (creates a pending Payment)
POST   /subscriptions/cancel      cancel at period end
```

**Files** (`/files`) - no auth; access is controlled entirely by a short-lived HMAC
signature in the query string, issued only by other authenticated API responses
```
GET    /files/:kind/:name?exp=...&d=inline|attachment&sig=...
```

**Admin** (`/admin`) - `owner_admin` only
```
GET    /admin/overview            ?days=7|30
GET    /admin/riders              PATCH /admin/riders/:id  (status: active|suspended)
GET    /admin/deliveries          GET /admin/deliveries/:id
GET    /admin/reports
GET    /admin/subscriptions       PATCH /admin/subscriptions/:id
GET    /admin/plans               PATCH /admin/plans/:key
GET    /admin/payments            POST /admin/payments   PATCH /admin/payments/:id
GET    /admin/settings            PUT /admin/settings
GET    /admin/audit-logs
```

**Health**
```
GET    /health                    liveness, no auth
GET    /ready                     readiness (checks the DB connection), no auth
```

## 8. PDF Import Pipeline
Upload -> validate file type by magic bytes (not just the declared MIME type) ->
extract text (`pdf-parse`) -> parse into per-delivery blocks -> detect parcel ID,
customer, phone and address with regex heuristics (payment columns are recognised
only so they don't leak into addresses) -> flag anything ambiguous
(`missing_address`, `duplicate`, etc.) -> return the full draft to the client for review -> the rider
edits/deselects rows in-app -> confirmed rows are submitted to `POST /deliveries/bulk`
to actually create them. Nothing is ever silently guessed or auto-imported.

## 9. Routing Pipeline
On `POST /routes/build`: load the rider's own pending, unrouted deliveries -> geocode
any address not yet resolved (results cached by normalized address) -> group
same-address stops when preference is "smart" -> run a nearest-neighbor pass -> refine
with 2-opt for "smart"/"shortest" -> persist stop order and per-leg distance/duration
on the `Route` document -> update each `Delivery`'s `routeId`/`stopOrder`. A route
auto-completes once every one of its stops is `delivered` or `failed`.

## 10. Photo Storage
Proof photos are validated by magic bytes, stored via `storage.service.js` (local
disk today, swappable for object storage), and referenced from the `Delivery`
document as `{ photoKey, capturedAt }`. Access is only ever through a short-lived
signed URL (`/files/...`) - never a public/static path.

## 11. Report Generation
Generated server-side per rider per calendar day (`report.service.js`), containing the
route summary, and per-delivery parcel ID, customer (when known), address,
delivery status, failure reason, notes, timestamps and the embedded proof photo.
Stored as a PDF file and referenced by a signed download/view URL.

## 12. Data Ownership (no multi-tenancy)
There is no organization or tenant layer. Every rider-owned record is scoped directly
by `riderId` (deliveries, routes, reports) or `userId` (subscription, payments).
Authorization checks verify the authenticated user and, for a rider, that the
resource's `riderId`/`userId` matches their own id - nothing more is needed since
there's no intermediate ownership boundary to also check.

## 13. Validation
Zod schemas validate params, query and body on every route (`middleware/validate.js`).
Delivery state transitions are additionally enforced at
the Mongoose model level so they hold even for code paths that bypass the route layer
(e.g. background jobs).

## 14. Error Format
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": []
  }
}
```

## 15. Testing
`backend/tests/unit` (pure-function tests: PDF extraction, route planner) and
`backend/tests/integration` (full HTTP request/response tests via `supertest` against
a real MongoDB-compatible database) - 15 tests total, covering registration/login,
password/validation rules, per-rider delivery-limit enforcement, cross-rider
tracking-ID isolation, the full delivery state machine (arrive -> proof -> deliver /
fail), and the admin console working correctly with the database in its default,
no-special-setup state. Run with `npm test` from `backend/`.

## 16. Observability
Structured JSON logs (`pino`) with request IDs, centralized error logging, an audit
log collection for sensitive admin actions, `/health` and `/ready` endpoints. No
external monitoring/alerting integration is wired up.

## 17. Environment Variables (as implemented)
See `backend/.env.example` for the authoritative list with descriptions. Summary:

- `NODE_ENV`, `PORT`, `LOG_LEVEL`
- `MONGODB_URI`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `FILE_SIGNING_SECRET` (each a random
  32+ byte secret), `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`,
  `BCRYPT_ROUNDS`
- `CORS_ORIGINS`, `TRUST_PROXY`, `COOKIE_SAMESITE`, `COOKIE_SECURE`
- `STORAGE_DIR`, `SIGNED_URL_TTL_SECONDS`
- `GEOCODING_PROVIDER` (`nominatim`|`google`|`none`), `GEOCODING_USER_AGENT`,
  `GOOGLE_MAPS_API_KEY`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` (used only by `npm run seed:admin`)

Never commit a real `.env` file - only `.env.example` belongs in source control.

## 18. Payments
The only money the platform tracks is SaaS **subscription** billing a rider pays the
platform (`Payment` / `Subscription`, always billed to `userId`). Customer payment
(prepaid order value / cash on delivery) is not part of the product.
