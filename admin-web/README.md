# Delivery Planner - Admin Web

Platform admin console for Delivery Planner. Manages riders, deliveries, reports,
subscriptions, plans, payments, platform settings, and the audit log directly - there
is no organization/customer layer to configure first; every rider that signs up is
immediately visible and manageable here.

See `../01-PRD.md` (Admin Web Requirements) and `../02-TRD.md` (API Reference) at the
repo root for what each page does and which endpoints it calls.

## Stack
React 19 + TypeScript + Vite. No router library - `App.tsx` holds a small sidebar +
page-switch shell. No component library - hand-rolled UI in `App.css`.

## Structure
```
src/
├── lib/          api.ts (fetch client + access-token refresh), auth.tsx (auth
│                 context, cookie+CSRF web login flow), types.ts, format.ts
├── components/   Modal, Pagination, StatusBadge, Toast
└── pages/        Login, Overview, Riders, Deliveries, Reports, Subscriptions,
                  Plans, Payments, Settings, AuditLogs
```

## Running it
```bash
cp .env.example .env    # VITE_API_URL=http://localhost:4000
npm install
npm run dev              # start the dev server
npm run build             # type-check (tsc -b) + production build
```

Login uses an httpOnly refresh-token cookie plus an `X-Requested-With` header as CSRF
protection (see `lib/api.ts` / `lib/auth.tsx`) - the backend's CORS config
(`CORS_ORIGINS`) must include whatever origin this dev server or deployment runs on.

## Vite template notes
This was scaffolded from Vite's React+TypeScript template. Two official plugins are
available for Fast Refresh: `@vitejs/plugin-react` (uses Oxc) and
`@vitejs/plugin-react-swc` (uses SWC) - this project uses the former. See
[Oxlint rules](https://oxc.rs/docs/guide/usage/linter/rules) if you want to enable
type-aware linting.
