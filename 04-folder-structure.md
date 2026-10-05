# Delivery Planner - Folder Structure

> Status: this is the actual folder structure of the project as built, not an
> aspirational target. The earlier draft of this doc described a monorepo layout
> (`apps/`, `packages/`, a repository layer, a `notifications`/`organizations`
> module, etc.) that was never built that way - replaced below with reality.

```text
delivery planner/
├── backend/
│   ├── src/
│   │   ├── config/            env.js (validated with Zod), database.js
│   │   ├── middleware/        auth.js, validate.js, rate-limit.js, upload.js, error.js, request-id.js
│   │   ├── models/            one Mongoose model per file (see 05-backend-schema.md)
│   │   ├── modules/           thin Express routers, one folder per API area:
│   │   │   ├── auth/          admin/  config/  deliveries/  files/
│   │   │   ├── reports/       rider/  routes/  subscriptions/
│   │   │   └── common/        shared Zod schemas (schemas.js)
│   │   ├── services/          ALL business logic lives here, one file per concern:
│   │   │                      auth, delivery, route (+ route-planner), report,
│   │   │                      pdf-import, geocoding, subscription, payment,
│   │   │                      rider-dashboard, admin, settings, storage, audit,
│   │   │                      serializers
│   │   ├── jobs/               background sweep (expires lapsed subscriptions hourly)
│   │   ├── utils/               logger, errors, http helpers, tokens, signed-url, geo
│   │   ├── app.js               Express app wiring (middleware + routers)
│   │   └── server.js            boot: connect DB, seed default plans, start jobs, listen
│   ├── scripts/
│   │   └── seed-admin.js        creates/updates the first platform admin (owner_admin)
│   ├── tests/
│   │   ├── unit/                 pure-function tests (pdf-import, route-planner)
│   │   └── integration/          full HTTP tests against a real MongoDB (supertest)
│   ├── uploads/                   local file storage (proof photos, generated reports)
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
│
├── admin-web/                     Vite + React + TypeScript
│   └── src/
│       ├── lib/                   api.ts (fetch client + token refresh), auth.tsx,
│       │                          types.ts, format.ts
│       ├── components/            Modal, Pagination, StatusBadge, Toast
│       ├── pages/                 Login, Overview, Riders, Deliveries, Reports,
│       │                          Subscriptions, Plans, Payments, Settings, AuditLogs
│       ├── App.tsx                sidebar + page routing (no external router lib)
│       └── App.css / index.css
│
├── rider-app/                     Expo + React Native (SDK 57)
│   └── src/
│       ├── lib/                   api.ts (fetch client + token refresh via
│       │                          AsyncStorage), auth.tsx, nav.tsx (custom
│       │                          lightweight stack/tab router - NOT Expo Router,
│       │                          see rider-app/AGENTS.md), types.ts, format.ts, theme.ts
│       ├── components/            Kit.tsx (Button, Card, Field, Badge, Banner, ...)
│       └── screens/               Login, Register, Dashboard, DeliveriesList,
│                                   DeliveryDetail, AddManual, ImportPdf, History,
│                                   Reports, Subscription, Account
│   ├── App.tsx                    top-level nav shell + auth gate
│   ├── app.json                    Expo config (camera/photo permissions)
│   └── .env.example
│
├── 01-PRD.md
├── 02-TRD.md
├── 03-design.md
├── 04-folder-structure.md         (this file)
├── 05-backend-schema.md
├── README.md
└── REBUILD-NOTES.md               history of what changed and why, useful context
                                    before touching auth/subscription/billing code
```

Business logic belongs in `services/`, never in route handlers (`modules/*/*.routes.js`
stay thin: validate input, call a service, shape the response). There is no repository
layer between services and Mongoose - services call models directly.
