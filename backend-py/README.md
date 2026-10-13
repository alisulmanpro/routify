# Routify API (FastAPI + Prisma + PostgreSQL)

The REST API behind the rider app and the admin console. It replaces the Node/Express/MongoDB
server in `../backend` and keeps **the exact same API contract**: the same `/api/v1` routes, JSON
envelopes, error codes, cookies, signed file URLs and JWT format. Neither app needs changes.

## Run it

```bash
docker compose up -d                       # PostgreSQL 16 on localhost:5433
python -m venv .venv
.venv\Scripts\activate                     # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                       # fill in the three secrets + DATABASE_URL
prisma migrate deploy                      # create the tables
python -m scripts.seed_admin               # first platform admin (ADMIN_EMAIL / ADMIN_PASSWORD)
python -m app                              # http://localhost:4000 (reloads on code changes)
```

API docs are served at `http://localhost:4000/docs` outside production.

## Tests

```bash
docker exec routify-postgres psql -U routify -c "CREATE DATABASE routify_test;"   # once
pytest
```

The 15 tests ported from the Node API run alongside 17 contract tests: auth cookies and refresh
rotation, error envelopes, ID and date formats, uploads, signed URLs and PDF/CSV import. The suite
resets the `routify_test` database on every run and never touches your dev data.

## Moving data from the old MongoDB

```bash
python -m scripts.migrate_from_mongo --wipe --uploads-from ../backend/uploads
```

This copies every collection, keeping the IDs, plus the proof photos and report PDFs. Riders stay
logged in, and existing links keep working. Run it again any time before switching over; `--wipe`
makes it a clean re-copy.

## Email

Set `EMAIL_PROVIDER` in `.env` (all options are documented in `.env.example`):

- `smtp` works with practically any email service (Brevo, SendGrid, Mailgun, SES, Postmark, Zoho, Gmail...).
- `brevo`, `sendgrid`, `resend`, `mailgun` and `postmark` use that service's HTTP API with `EMAIL_API_KEY`.
- `console` (development default) prints emails, including reset codes, to the log. Production refuses it.

To add another service, subclass `Mailer` (or `HttpMailer` for a JSON API) in `app/services/mailer/providers.py`, add it to
`PROVIDERS` in `app/services/mailer/__init__.py`, and add its name to `EMAIL_PROVIDERS` in `app/config.py`.

## Forgot password

1. `POST /api/v1/auth/forgot-password` `{email}`: always answers `200 {sent: true}`, so the response never shows whether an
   account exists. If one does, a 6-digit code is emailed. The code lasts `PASSWORD_RESET_TTL_MINUTES` minutes.
2. `POST /api/v1/auth/reset-password/verify` `{email, code}` (optional): checks the code before the app asks for a new password.
3. `POST /api/v1/auth/reset-password` `{email, code, newPassword, confirmPassword}`: sets the password, signs out every
   session, clears any login lockout and emails a "password changed" notice. The user then signs in as usual.

A wrong or expired code returns `400 INVALID_RESET_CODE`. Each code allows 5 guesses, a new request replaces the old code,
and each email address can request 5 codes an hour.

## In-app purchases

Paid plans are sold through Apple In-App Purchase and Google Play Billing (the stores' rules for digital subscriptions).
`PAYMENT_STORES` picks which stores are on; `mock` is a fake store for development that needs no accounts.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/subscriptions/store` | Product IDs per store, and the rider's `accountToken` (pass it as Apple `appAccountToken` / Google `obfuscatedAccountId`) |
| `POST /api/v1/subscriptions/purchases` | `{store, receipt, productId}` after a purchase or "Restore purchases". Apple: the transaction's JWS. Google: the purchase token. Mock: just `productId` like `starter.monthly` |
| `POST /api/v1/subscriptions/mock/events` | Mock store only: `renew`, `cancel`, `resume`, `fail_renewal`, `grace`, `recover`, `expire`, `refund` |
| `POST /api/v1/billing/webhooks/apple` | App Store Server Notifications V2 (set this URL for sandbox and production in App Store Connect) |
| `POST /api/v1/billing/webhooks/google` | Google Play Real-time Developer Notifications (Pub/Sub push subscription with authentication on) |

Receipts are always verified with the store (Apple's signature chain against the root CAs in `app/certs/apple`, or the
Play Developer API), a purchase can only ever belong to one rider, and store events applied out of order never roll a
subscription back. Product IDs live in the `billing.products` platform setting (editable with `PUT /admin/settings`).
Sandbox, license-tester and mock payments are marked `testMode` and left out of revenue totals.

**Free trial.** New riders start with no plan (`inactive`): there is no free trial without a card. The trial runs
through the store, and its length is the `trialDays` platform setting (7, 14 or 30, set in the admin console). The
stores run the trial themselves, so keep them matching: in Play Console give each base plan the offers
`free-trial-7d`, `free-trial-14d` and `free-trial-30d` (the app asks for the one named in `trialOfferId`); in App Store
Connect set each subscription's introductory offer to the same length (1 week, 2 weeks or 1 month).

## Changing the schema

Edit `prisma/schema.prisma`, then run `prisma migrate dev --name <what-changed>`. This creates a SQL
migration under `prisma/migrations/` and regenerates the Python client. In production, run
`prisma migrate deploy`.

## Layout

| Path | What it is |
|---|---|
| `app/main.py` | App factory: middleware, error handlers, routers, hourly jobs |
| `app/routers/` | HTTP layer: auth, deliveries, admin, plus the smaller rider-side routers |
| `app/services/` | Business logic, ported 1:1 from `backend/src/services` |
| `app/validation.py` | zod-compatible request validation (same error envelope) |
| `app/middleware.py` | Request IDs, helmet headers, rate limits, last-resort error handling |
| `prisma/schema.prisma` | Database schema; `prisma/migrations/` holds the SQL history |
| `scripts/` | `seed_admin`, `migrate_from_mongo` |

## Notes

- IDs are 24-character hex strings (MongoDB ObjectId format) so migrated records keep their IDs.
- `Delivery.version` gives the same optimistic-concurrency 409 that Mongoose's `__v` did.
- Expired geocode-cache rows and old refresh tokens are cleaned up by the hourly job (MongoDB used TTL indexes).
- `prisma-client-py` is no longer maintained upstream. It pins Prisma engine 5.17, which works, but plan to move the data layer to SQLAlchemy eventually. The schema and SQL migrations carry over as they are.
