# Delivery Planner - Product Requirements Document (PRD)

> Status: reflects the platform as actually built. See `REBUILD-NOTES.md` for the
> history of how it got here (it went from a hardcoded prototype -> org-optional ->
> fully rider-only).

## 1. Product Overview
A rider-first delivery-management SaaS with two interfaces: a Rider Mobile App and a
platform Admin Web Dashboard. There is **no organization, team, or business-account
concept anywhere in the product.** Every rider signs up on their own, subscribes on
their own, and runs their own deliveries independently. The admin dashboard manages
riders, deliveries, reports, subscriptions and payments directly - nothing routes
through an intermediate "customer" or "organization" entity.

## 2. Goals
- Let a rider import deliveries from a PDF courier manifest or enter them manually.
- Require every delivery to have a Prepaid or COD payment type.
- Extract payment information from PDFs when possible, but require rider review when
  uncertain - never guess.
- Build delivery routes and guide riders through execution, stop by stop.
- Require a delivery proof photo before a delivery can be confirmed.
- Generate daily PDF reports per rider.
- Give platform admins full visibility and control over riders, deliveries, reports,
  subscriptions and payments - with zero setup overhead (no "create an account for
  this customer" step; every rider already has everything they need the moment they
  register).
- Keep SaaS subscription finances (what a rider pays the platform) strictly separate
  from customer COD collections (what a rider collects from their own customers).

## 3. Rider Requirements
### Authentication
Full name, phone, email, password and confirmation. Self-service sign-up creates an
independent account immediately - no invitation, approval, or organization setup step.
Secure login/logout and token-based sessions (rotating refresh tokens).

### Currency
Initial options: USD, GBP, EUR, PKR, INR. Selected currency is used throughout the
rider app and can be changed in Account.

### Dashboard
Show total, delivered, remaining, failed, prepaid, COD, COD collected, route progress,
a map preview of geocoded stops, and the appropriate next action (set up deliveries /
start route / continue route / view report).

### Delivery Setup
Options: Import PDF or Add Manually.

PDF states: uploading, reading, extracting, processing addresses, identifying payment
type, finding locations, building route.

Attempt to extract tracking ID, customer, phone, address, payment type, order value
and COD amount from the PDF text.

Manual fields: tracking ID, customer name, phone, address, payment type, amount and
optional note.

### Payment Type
Every delivery must be either PREPAID or COD.

- Prepaid means the customer already paid and the rider collects nothing.
- A prepaid order value must be labelled Order Value, not Amount to Collect.
- COD requires an Amount to Collect greater than zero.
- If PDF extraction cannot confidently determine payment type, flag it for rider
  review instead of guessing.
- Payment type must remain visible in setup, review, active delivery, confirmation,
  history, reports and admin.

### Route Preferences
Smart Route (default, groups same-address stops), Nearest First, Shortest Route.

### Review
Show tracking ID, customer, address, phone, payment type, amount and location status.
Support edit, delete and review before importing. Flag missing/invalid address,
location-not-found, duplicate tracking IDs, missing customer information, missing
payment type and missing COD amount.

Summary includes total deliveries, prepaid, COD, total COD amount, and estimated
distance/time once a route is built.

### Active Delivery
Stop list shows destination, customer/address, distance, payment type/amount, and
tracking ID for the current and upcoming stops. A tap opens the full delivery detail.

Actions: Navigate (opens the device's map app), Arrived, Delivered, Delivery Failed.
The rider works through their route stop by stop; the app surfaces the next open stop.

### Delivered
A proof photo is required before final confirmation (captured live or chosen from the
library). Prepaid shows no collection amount. COD shows the Amount to Collect and
requires the rider to explicitly confirm they collected it before the delivery can be
marked delivered. Optional note.

### Failed
Reasons: Customer unavailable, Customer refused, Wrong address, Phone unreachable,
Business closed, Payment issue, Other. Other requires a reason detail. Optional note.

### Route Complete
A route automatically completes once every stop is delivered or failed. History shows
total, delivered, failed, prepaid, COD, COD collected, distance for that day.

### Daily PDF Report
Generated on demand per calendar day. Includes rider, date, route summary, total,
delivered, failed, prepaid, COD, COD collected and distance. Each delivery includes
tracking ID, customer, address, payment type, order value when available, COD amount
when applicable, collection/payment status, delivery status, timestamp, embedded photo
and note. Failed deliveries include the failure reason.

### History
Per-day rollup: date, total, delivered, failed, prepaid, COD, COD collected and
distance, with a link to that day's report if one has been generated.

### Account
Profile (name/phone/currency/route preference), Subscription & plans, change
password, Sign out.

### Subscription
Free Trial (starts automatically on sign-up), Starter and Pro. Supports monthly and
annual billing, shows the current plan, usage against its limits, renewal date, and
lets the rider request an upgrade or cancel at period end. Subscription is entirely
personal to the rider - nothing is shared or pooled with anyone else.

## 4. Admin Web Requirements
Sidebar: Overview, Riders, Deliveries, Reports, Subscriptions, Plans, Payments,
Settings, Audit Logs. There is intentionally no "Organizations" or "Customers" item -
riders are the only account type the platform has.

Overview metrics: total riders, riders active in the last 24h, deliveries today,
active routes, active subscriptions, trials, expired subscriptions, billing-cycle
distribution, prepaid vs COD mix, and COD amount collected today (shown separately
from subscription revenue this month). Charts cover delivery volume, subscription
growth and revenue trend, live route progress, and a payment-mix donut.

Riders: name, email, subscription status, delivery counts (prepaid/COD), COD
collected, last active, registration date, active/suspended status, and a
suspend/reactivate action.

Deliveries: filter by date, rider, status and payment type. Show tracking ID,
customer, rider, address, payment type, amount, COD collection status, delivery
status, timestamp, proof photo and any failure reason.

Reports: search, filter, and download a rider's generated PDF reports.

Subscriptions: rider, plan, billing cycle, price, currency, status, start date and
renewal date, with an admin override to change plan/cycle/status or extend the
current period.

Plans: Free Trial, Starter and Pro, each with configurable monthly/annual prices,
currency, active feature list, and delivery/report limits per month.

Payments: pending, succeeded, failed and refunded SaaS subscription payments, always
billed directly to a rider (searchable by name/email). Admins can record a manual
payment and mark it succeeded to activate a rider's plan immediately, or mark
pending/failed/refunded as the real-world payment status changes. These records are
completely separate from a rider's own customer COD collections.

Settings: enabled currencies and default, trial length, route defaults (preference,
average speed, per-stop service time), report options, platform info (name, support
email, privacy URL, payment instructions shown to riders when upgrading), and
security policy (minimum password length, lockout threshold/duration).

Audit Logs: timestamp, acting admin, action, target, status and IP, for every
sensitive admin action (rider suspension, plan edits, payment changes, settings
changes, etc.).

## 5. Non-Goals
Multi-rider team/business accounts, an organization or "customer" concept of any
kind, restaurant/merchant marketplace features, social/chat features, complex CRM,
warehouse management, and excessive rider analytics.

## 6. Success Criteria
A rider can sign up on their own, import/create deliveries, verify payment types,
build a route, complete deliveries with proof, record COD collections, handle
failures, and generate a complete daily report - entirely independently, with no
setup step performed on their behalf. Platform admins can manage every rider,
delivery, report, subscription and payment directly, with no organization or
customer setup required for the console to be fully functional.
