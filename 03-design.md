# Delivery Planner - Design System and UX Specification

> Status: this doc was UX/design guidance from the start and required no changes for
> the organization removal - it never referenced organizations. Kept as-is below.

## 1. Design Direction
Professional, fast and operational. Rider experience prioritizes speed and clarity; admin can be information-dense.

## 2. Interfaces
Rider: mobile-first, one-handed, map-focused, large primary actions.
Admin: desktop/laptop first, responsive to tablet, data-rich tables and filters.

## 3. Layout
Rider: top status/header, main map/content, bottom action area and minimal navigation.
Admin: persistent sidebar, top bar and main content with responsive collapse.

## 4. Semantic Tokens
primary, secondary, background, surface, text, muted, success, warning, error, info.

Do not use color alone for state.

## 5. Typography
Display, H1, H2, H3, Body, Small, Caption and Button styles.

## 6. Components
Buttons, inputs, dropdowns, search, cards, tables, status badges, payment badges, tabs, bottom navigation, sidebar, modals, bottom sheets, toasts, alerts, progress, empty states, skeletons and confirmation dialogs.

## 7. Payment Selector
Simple segmented control: PREPAID | COD.

Prepaid: show PREPAID and, if known, Order Value.
COD: show COD and Amount to Collect.

## 8. Delivery Card
Tracking ID, customer, address, payment type, relevant amount, status and location state.

## 9. Active Delivery
Priority: map, destination, customer/address, payment type/amount, primary action, secondary actions.

## 10. Interaction Rules
Primary actions are dominant. Avoid nested workflows. Confirm meaningful irreversible actions. Use inline validation. Preserve data after validation errors. Automatically advance after successful delivery/failure confirmation.

## 11. Accessibility
Touch targets around 44px+, strong contrast, focus states, labels, meaningful errors and no color-only status.

## 12. Responsive Rules
Rider supports small and large phones with safe-area handling. Admin supports desktop, laptop and tablet; sidebars collapse and large tables adapt using scroll or cards.

## 13. UX Copy
Use short action-oriented copy such as Set Up Delivery, Start Delivery, Navigate, Arrived, Mark Delivered, Delivery Failed, Collect amount, Confirm Delivery and Download Report.

## 14. Required States
Empty dashboard, PDF uploading/processing, payment detected/needs review, invalid PDF, address not found, GPS unavailable, offline, route calculating/failed, photo upload/failed, delivery success/failed, COD confirmation, route complete, report generating/ready/download failed, subscription expired/payment failed, loading and server error.

## 15. Rider UX Priority
1. Set up deliveries
2. Verify payment type
3. Start route
4. Navigate
5. Mark delivered
6. Mark failed
7. Add photo
8. Add optional note
9. Confirm COD collection where applicable
10. Auto-continue
11. Finish route
12. Download report

Avoid excessive animation, decorative dashboards, complex rider analytics, long onboarding, social/chat, unnecessary settings and excessive popups.
