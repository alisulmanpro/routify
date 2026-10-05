# Delivery Planner - Backend Schema

> Status: reflects the actual Mongoose models in `backend/src/models/`. There is no
> `Organization` or `OrganizationMember` collection - that concept was built, then
> explicitly removed. Every rider is a fully independent account.

## Collections
`users`, `refreshtokens`, `deliveries`, `routes`, `reports`, `plans`, `subscriptions`,
`payments`, `auditlogs`, `settings`, `geocodecaches`.

## User Document
```js
{
  _id,
  fullName, phone, email, passwordHash,
  role: "rider" | "owner_admin",
  currency, routePreference: "smart" | "nearest_first" | "shortest",
  notificationsEnabled,
  status: "active" | "suspended",
  failedLoginCount, lockedUntil,      // account-lockout bookkeeping, select: false
  lastActiveAt,
  createdAt, updatedAt
}
```
No `organizationId` field. A rider's identity alone is enough to scope every other
document that belongs to them.

## Delivery Document
```js
{
  _id,
  riderId,
  trackingId,                          // unique per rider, not globally
  customer: { name, phone },
  address: { raw, normalized, latitude, longitude, geocoded, geocodeStatus },
  payment: {
    type: "prepaid" | "cod",
    currency, orderValue,
    codAmount, codCollectedAmount,
    collectionStatus: "not_required" | "pending" | "collected"
  },
  status: "pending" | "in_progress" | "delivered" | "failed",
  proof: { photoKey, photoUrl, capturedAt },
  note,
  failure: { reason, note },
  serviceDate,                         // "YYYY-MM-DD"
  routeId, stopOrder,
  arrivedAt, deliveredAt, failedAt,
  createdAt, updatedAt
}
```

## Business Rules (enforced in the model's own `pre('validate')`, not just the API)
- COD requires `codAmount > 0`.
- Prepaid clears `codAmount`/`codCollectedAmount` and sets `collectionStatus` to
  `not_required`.
- `delivered` requires `proof.photoKey`, and if COD, requires `collectionStatus` to
  already be `collected`.
- `failed` requires `failure.reason`; reason `other` requires `failure.note`. A
  failed COD delivery can never also be marked `collected`.

## Route Document
```js
{
  _id, riderId, serviceDate,
  preference: "smart" | "nearest_first" | "shortest",
  status: "planned" | "active" | "completed",
  origin: { latitude, longitude },
  stops: [{ deliveryId, order, legDistanceKm, legDurationMin }],
  distanceKm, durationMin,
  startedAt, completedAt,
  createdAt, updatedAt
}
```
A route auto-completes (status -> `completed`) once every one of its stops is
`delivered` or `failed` - there is no separate "end route" action today.

## Report Document
```js
{
  _id, riderId, date,               // one report per rider per calendar day (unique)
  summary: { total, delivered, failed, pending, prepaid, cod, codExpected,
             codCollected, currency, distanceKm, routeMinutes },
  fileKey, fileSize, generatedAt,
  createdAt, updatedAt
}
```

## Plan Document
```js
{
  _id, key: "trial" | "starter" | "pro", name,
  monthlyPrice, annualPrice, currency,
  limits: { deliveriesPerMonth, reportsPerMonth },
  features: [String],
  active,
  createdAt, updatedAt
}
```
No `ridersPerOrganization` limit - that field existed briefly for the team-account
design and was removed along with organizations.

## Subscription Document
```js
{
  _id,
  userId,                             // required, unique - one subscription per rider, always
  planKey: "trial" | "starter" | "pro",
  billingCycle: "monthly" | "annual",
  status: "trialing" | "active" | "past_due" | "expired" | "cancelled",
  price, currency,
  startedAt, currentPeriodEnd, cancelAtPeriodEnd,
  pending: { planKey, billingCycle, paymentId },   // set while an upgrade awaits payment confirmation
  createdAt, updatedAt
}
```

## Payment Document
```js
{
  _id,
  userId,                             // required - SaaS payments are always billed directly to a rider
  subscriptionId,
  planKey: "starter" | "pro", billingCycle,
  amount, currency,
  status: "pending" | "succeeded" | "failed" | "refunded",
  provider,                           // "manual" today - no payment gateway is integrated yet
  providerRef, paidAt,
  createdAt, updatedAt
}
```
This collection never contains a customer's COD money - only what a rider pays the
platform for their own subscription. See Financial Separation below.

## AuditLog Document
```js
{ _id, actorId, actorEmail, action, targetType, targetId, status, ip, meta, createdAt }
```

## Security
Authenticate every protected request (bearer access token, re-checked against the
live user record on every call). Authorize by resource ownership: a rider action is
only permitted on documents whose `riderId`/`userId` matches their own id - there is
no additional tenant/organization check to perform, since no such layer exists.
Validate every uploaded file by its actual content (magic bytes), not the declared
MIME type. Rate-limit auth and upload endpoints. Keep secrets out of source control.

## Services (`backend/src/services/`)
`auth.service`, `delivery.service`, `pdf-import.service`, `geocoding.service`,
`route-planner.service` (pure route-optimization logic), `route.service` (route
lifecycle), `report.service`, `storage.service`, `subscription.service`,
`payment.service`, `admin.service`, `settings.service`, `audit.service`,
`rider-dashboard.service`, `serializers` (shared response shaping).

There is no `OrganizationService`, `UserService`, or `NotificationService` - the
first two never had anything left to do once organizations were removed, and the
third was never built (no email/push/SMS integration exists yet).

## Background Jobs (`backend/src/jobs/`)
A single hourly sweep (`sweepSubscriptions`) that moves any subscription whose
`currentPeriodEnd` has passed into `status: "expired"`. PDF processing, geocoding and
report generation all happen synchronously within their own API request today, not as
queued background jobs.

## Financial Separation
Kept as separate concepts everywhere - schema, API responses, admin UI, and the PDF
report: (a) SaaS **subscription** payments a rider pays the platform (`Payment` /
`Subscription`, always keyed by `userId`), versus (b) a rider's own customer
**order value** (prepaid) or **COD amount / COD amount actually collected**, which
lives only on the `Delivery` document and is never aggregated into subscription
revenue figures.
