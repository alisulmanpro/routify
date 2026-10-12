# Delivery Planner

A rider-first delivery-management platform: riders sign up on their own, subscribe to
a plan, and run their own deliveries end-to-end (PDF/manual import, route planning,
proof-of-delivery, daily PDF reports). A separate admin console gives platform staff
full visibility and control over every rider, delivery, report, subscription and
payment. **There is no organization/team/business-account concept anywhere in this
product** - every rider is a fully independent account. See `REBUILD-NOTES.md` for
why that's worth calling out explicitly.

## What's in this repo

| Path          | What it is                                              |
|---------------|----------------------------------------------------------|
| `backend-py/` | FastAPI + Prisma + PostgreSQL REST API (`/api/v1`)       |
| `backend/`    | Legacy Node/Express/MongoDB API (same contract; kept until the switch is confirmed) |
| `admin-web/`  | Platform admin console - Vite + React + TypeScript        |
| `rider-app/`  | Rider mobile app - Expo + React Native                    |

Read `04-folder-structure.md` before navigating any of the three for the first time.

## Docs in this folder

- `01-PRD.md` - product requirements (what the app does and why)
- `02-TRD.md` - technical requirements, including the full API reference
- `03-design.md` - UI/UX design system and interaction rules
- `04-folder-structure.md` - the actual folder layout of all three apps
- `05-backend-schema.md` - Mongoose models, business rules, and service list
- `REBUILD-NOTES.md` - history of what changed, why, and what's genuinely still
  missing (start here if you're picking this project up for the first time)

All of the numbered docs describe the platform **as it is currently built and
verified**, not an aspirational target - if you find a mismatch between a doc and the
code, the code changed and the doc slipped; please fix the doc.

## Quick start

**Backend** (needs PostgreSQL; `docker compose up -d` in `backend-py/` starts one on port 5433):
```bash
cd backend-py
python -m venv .venv && .venv\Scripts\activate   # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env      # fill in JWT/refresh/file-signing secrets + DATABASE_URL
prisma migrate deploy     # create the tables
python -m scripts.seed_admin   # requires ADMIN_EMAIL + ADMIN_PASSWORD (10+ chars) in .env
python -m app             # http://localhost:4000
pytest                    # 32 unit + integration tests against a real PostgreSQL
```

**Admin web:**
```bash
cd admin-web
cp .env.example .env      # VITE_API_URL=http://localhost:4000
npm install
npm run dev
```

**Rider app:**
```bash
cd rider-app
cp .env.example .env      # EXPO_PUBLIC_API_URL=http://<your-machine-ip>:4000
npm install
npx expo start
```

## Stack

- Backend: Python + FastAPI + Prisma (prisma-client-py) + PostgreSQL
- Admin web: React + TypeScript + Vite
- Rider app: React Native + Expo
- Auth: JWT access tokens + rotating refresh tokens (bcrypt password hashing)

