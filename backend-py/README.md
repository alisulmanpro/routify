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
