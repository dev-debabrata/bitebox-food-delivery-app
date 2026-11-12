# BiteBox Django migration: Phase 1 deliverables

Phase 1 output for [MASTER_PROMPT.md](../MASTER_PROMPT.md) (Part C). **No application code has been written.** Implementation starts after these documents and the decisions below are approved.

| Deliverable (MASTER_PROMPT Part C) | Document |
|---|---|
| A. Requirement analysis, assumptions, open questions | [01-requirements-and-scope.md](01-requirements-and-scope.md) |
| K. MVP vs. future releases | [01-requirements-and-scope.md §1.6](01-requirements-and-scope.md#16-mvp-versus-later-releases) |
| B. System architecture diagram | [02-architecture.md §2.1](02-architecture.md#21-system-architecture) |
| C. Workflow diagrams (order, payment, dispatch, refund, KYC) | [02-architecture.md §2.3–2.4](02-architecture.md#23-order-lifecycle-proposed) |
| M. DRF architecture and API strategy | [02-architecture.md §2.5](02-architecture.md#25-drf-strategy) |
| O. Leaflet + OSM + geo adapters, PostGIS decision | [02-architecture.md §2.7](02-architecture.md#27-maps-and-geo-architecture) |
| D. ER diagram | [03-data-model.md §3.2](03-data-model.md#32-er-diagram) |
| E. Table specifications + MongoDB → PostgreSQL mapping | [03-data-model.md §3.3–3.4](03-data-model.md#33-table-specifications) |
| F. API specification (existing + new) | [04-api-spec.md](04-api-spec.md) |
| G. Frontend changes, NexPrime migration inventory | [05-frontend-plan.md](05-frontend-plan.md) |
| L. Signal Forms strategy | [05-frontend-plan.md §5.6](05-frontend-plan.md#56-signal-forms-strategy) |
| N. NexPrime strategy | [05-frontend-plan.md §5.5](05-frontend-plan.md#55-nexprime-strategy) |
| H. Django folder structure | [06-backend-structure-and-milestones.md §6.2](06-backend-structure-and-milestones.md#62-folder-structure) |
| I. Milestones and task breakdown | [06-backend-structure-and-milestones.md §6.4](06-backend-structure-and-milestones.md#64-milestones-and-task-breakdown) |
| J. Risks and security plan | [07-risks-and-security.md](07-risks-and-security.md) |
| Phase 2: NexPrime API check | [08-nexprime-api-check.md](08-nexprime-api-check.md) |
| Phase 2: wireframes for new screens | [09-wireframes.md](09-wireframes.md) |

## Status

| Phase | State |
|---|---|
| 1. Analysis | Done. The decisions below were accepted as recommended when the user said "continue" (12 Nov 2026). Q1–Q4 are still open. |
| 2. UI/UX + theme | Done: dark theme, `ThemeService`, `BbDialog` (CDK) used for every confirm dialog, NexPrime API check, wireframes. |
| 3. Django skeleton | Done: `backend-django/` (settings, envelope and errors, pagination, permissions, health, OpenAPI, `/ws/` protocol, Celery, Docker, CI job). Docker and the PostgreSQL/Redis CI job could not be run locally (see the Phase 3 report). Done. |
| 4. Parity schema | Done: 45 tables in 17 apps, migrations, constraints and indexes, `manage.py seed`, 83 tests, all passing on PostgreSQL 16 + PostGIS 3.4 (local install), including 15 PostgreSQL-only tests: geography columns, KNN, indexes and the ledger trigger. Changes from the plan: [03 §3.5](03-data-model.md#35-phase-4-implementation-notes-what-changed-from-the-plan-above). Done. |
| 5. Auth + RBAC | Done: register, login (with portal check), rotating refresh cookie with reuse detection, logout, forgot/reset/change password, `/auth/me`, admin users, staff admins, audit log, permission classes, WebSocket sign-in. Ported Node `auth.test.js` and the admin-management part of `admin-roles.test.js`: 141 tests pass on PostgreSQL. **Not switched in the frontend:** Django tokens name PostgreSQL users that Node (MongoDB) doesn't know, so `/auth` moves together with the features that use the signed-in user (see the Phase 5 report). OTP login and email verification stay in release 2. |
| 6. Catalogue + cart | Done: restaurants (public discovery with PostGIS distance, partner onboarding, admin review), categories, dishes, image uploads, place search and routing, saved addresses, the server-priced cart quote and coupons. Ported `catalog.test.js`, `geo.test.js`, and the cart, address and coupon parts of `checkout.test.js` and `admin.test.js`: 207 tests pass on PostgreSQL. Tests now require PostgreSQL. Reviews on the catalogue pages, placing orders and coin earning/spending belong to later phases. Done. |
| 7. Orders + dispatch + realtime | Done: placing orders (idempotent, cart claim, atomic coupon reservation, snapshots, COD payment row), the status workflow with Node's transition table, customer/partner/rider/admin order endpoints, nearest-rider dispatch with PostGIS, the sweep as a Celery Beat task, status notifications, the settlement split on delivery, and live updates over `/ws/` (rooms, tracking, rider positions, `notification:new`). Ported `orders.test.js`, the placing-orders part of `checkout.test.js`, `realtime.test.js` and the socket part of `tracking.test.js`: 250 tests pass on PostgreSQL. Frontend: `RealtimeService` now runs over a transport (`core/services/realtime-transport.ts`) with Socket.IO for Node and a plain WebSocket for Django, chosen by `environment.realtime` (still `'node'`). Differences from Node: online payment answers "not available" until Phase 8 (cash works); coin redemption at checkout is refused until the coin wallet is ported; races are tested by injecting the competing write (tests run in one transaction). Arrival at the restaurant and the delivery OTP stay in Phase 12. Done. |
| 8. Restaurant dashboard (the user's phase list from here: 9 rider app, 10 admin, 11 order lifecycle, 12 payments, 13 maps/tracking, 14 notifications/jobs, 15 settlements/reports, 16 testing/security, 17 staging, 18 production, 19 monitoring) | Done: Django `/my/restaurant/stats` (dashboard figures), `/my/restaurant/earnings`, the partner reviews endpoints (grouped by order, summary, replies) and `refresh_rating`; 255 tests pass. Frontend: the restaurant panel is on NexPrime (no Angular Material left in it): `np-button`, `np-button-toggle`, `np-pagination`, `np-menu`, `np-spinner`, BbDialog for the dish, review and report dialogs, `.bb-btn` for submit buttons and links; the dashboard shows the order figures (hidden while the app talks to the Node API, which lacks that endpoint). Verified in a headless browser against a throwaway Django API. The Node backend is not changed. §3B items still open: KYC/FSSAI/GST/bank details and documents, categories per restaurant, variants/add-ons/stock, preparation time per order, holidays and delivery radius settings, settlement history/payouts/invoices (planned with the KYC, menu-extras and finance phases). Done. |
| 9. Delivery partner application | Done: Django `/delivery/reviews`, `/delivery/earnings`, `/delivery/stats` (today, this week from Monday, all time, in REPORT_TIMEZONE), and on every rider order view what the delivery pays (`estimatedEarningsPaise`) plus, on the offer, the straight-line distance to the pickup. 259 tests pass. Frontend: the rider panel is on NexPrime (dashboard, history, ratings: `np-button`, `np-progress-bar`, `np-pagination`, `.bb-btn`); the dashboard shows the earnings figures and the request card shows "You earn" and "To pickup" (hidden or absent while the app talks to the Node API). Verified in a headless phone and desktop browser against a throwaway Django API: go online, request, accept, pick up, deliver, figures update. Node backend not changed. §3C items still open: rider registration KYC (licence, vehicle registration, identity, bank details, profile photo), incentives, payout history and bank account management (KYC and finance phases), arrival at the restaurant and the delivery OTP (Phase 11, order lifecycle). Done. |
| 10. Admin dashboard | Done: Django `/admin/reports`, `/admin/operations/{dashboard,monitoring,restaurants,performance}` (Node parity; delivery performance aggregated in SQL), plus from §3D `/admin/dashboard` (people, orders by state; GMV, platform revenue and pending settlements for finance:view) and login history (`/admin/users/{id}/logins`, `/admin/admins/{id}/logins`). 266 tests pass. Frontend: the admin dashboard, users, staff, audit log, restaurants and restaurant review, categories, dishes, coupons, orders, delivery partners and operations screens are on NexPrime: `np-button`, `np-tabs` (as a tab strip), `np-button-toggle`, `np-pagination` (compact), BbDialog for the staff, category, coupon and order dialogs, and a plain `.bb-table` where cells hold chips and buttons (np-table can't). New: the platform tiles on the admin home and a sign-in history dialog on the staff screen (hidden or explained while the app talks to the Node API). Verified in a headless browser against a throwaway Django API: every screen loads with no page or server errors. Node backend not changed. Still on Material and moved with their phases: finance and payments (Phases 12, 15), rewards and promotions (coins), support and review moderation (Phase 14), plus the shared shell (`layout/panel-shell`). §3D items still open: commission configuration, settlement and payout management, refunds and disputes, support tickets, system settings, KYC review. Done. |
| 11. Order lifecycle and dispatch | Done (the workflow, dispatch, the sweep and realtime were built in the earlier orders phase): the `arrived_at_restaurant` status (D3), the delivery OTP (made at pickup, customer-only, required for "delivered", 5 tries then support resets it), the restaurant's preparation time on accept (`readyBy` for the customer), manual rider assignment by admins (withdraws an open offer), and `GET /orders/{id}/timeline`. The sweep and the operations board know the new status. 275 tests pass (10 new). Frontend: the customer sees the delivery code and the expected ready time; the rider app takes its steps from `nextStatuses` (arrival step) and asks for the code in a dialog; restaurants pick a preparation time when accepting; admins can assign a rider and send a new code. All of it only appears when the Django API sends the new fields, so the Node-based app is unchanged. Verified end to end in a headless browser (restaurant, customer, admin and rider sessions) against a throwaway Django API. Node backend not changed. Still open: payment exception flows (failure, timeout, duplicate webhook, refunds) in Phase 12; delivery failure stays an admin cancellation with a reason. Done. |
| 12. Payments | Done: online payment in Django (Node parity): the simulated provider and Razorpay behind one provider interface, start/confirm/abandon/mock endpoints, the signed webhook (raw body, each event id once), paid/failed exactly once, unpaid orders hidden from restaurants, late payments refunded, refunds when a paid order is rejected or cancelled, admin list and retry. Added (master prompt §9): refunds as rows with full and partial amounts (`partially_refunded`, D3), cash refunds paid by hand, refund status from the gateway (webhook and polling), a reconciliation task (`payments.reconcile`, every 5 min), payment detail with its gateway events, and the customer's payment history (`GET /payments/mine`). 296 tests pass (21 new). Frontend: the simulated gateway and the transaction details are on BbDialog, the Transactions screen is on NexPrime with a refund dialog (full or partial, history, "Mark paid" for cash), the customer's order shows its refunds, and a new Payments page lists the customer's payments. The new parts only appear when the Django API sends their fields. Verified in a headless browser against a throwaway Django API (simulated payments only). Node backend not changed. Still open: transaction details need the finance endpoint (Phase 15); payment attempts table, disputes and invoices with finance/support. Awaiting approval for Phase 13. |

## Key findings

1. The Node backend is complete and well tested (~350 tests). It becomes the **specification**, and its tests become the Django acceptance suite.
2. The frontend already meets the Signal Forms rule (0 Reactive Forms). The Material → NexPrime work is the main frontend cost (107 files; `MatDialog` in 68).
3. NexPrime 0.1.5 has no programmatic dialog service. Recommendation: use `@angular/cdk/dialog` (not Material) behind a small facade.
4. There is no dark theme yet. NexPrime supports `data-theme="dark"`.
5. The backend's Vercel deployment can't run sweeps or sockets. Docker or VM is the only complete target, now and for Django.
6. The largest functional gaps: KYC (FSSAI, documents, bank details), variants and add-ons, delivery OTP, partial refunds, invoices, SMS/OTP login.

## Decisions needing approval

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Money storage | **Integer paise (`bigint`)**, not `DecimalField` | Exact arithmetic, matches today's API (`*Paise`) and frontend, and avoids conversions at every boundary. Decimals add no precision for INR at paise resolution. |
| D2 | Angular workspace | **Keep the single app** with lazy panels | Already code-split. Splitting adds four builds and cross-app auth with no user benefit. |
| D3 | Order statuses | **Add `arrived_at_restaurant`. Delivery OTP is a precondition on `delivered`. Delivery failure = admin cancellation with a reason.** Add `partially_refunded` payment status. | Smallest change that covers the master prompt's workflow |
| D4 | Roles and permissions storage | **Keep in code** (not `roles`/`role_permissions` tables) | Small fixed set, versioned with code, no extra query per request |
| D5 | Geo | **PostGIS** (GeoDjango) | Exact KNN nearest-rider queries with an index. Available on managed PostgreSQL. |
| D6 | Dialogs | **`@angular/cdk/dialog`** with NexPrime-styled content | NexPrime lacks a programmatic opener. CDK is not Material. |
| D7 | Migration approach | **Build `backend-django/` alongside, keep the API contract, switch over via nginx** | Testable parity, reversible cut-over |
| D8 | Release scope | **MVP = parity + switch-over + delivery OTP + KYC + partial refunds + customer/rider NexPrime** (see 01 §1.6) | Replaces the platform with measurable risk first |
| D9 | Payment providers | **Razorpay only** (Cashfree later behind the same interface) | Already integrated and tested |
| D10 | SMS provider | **MSG91 adapter**, OTP login in release 2 | DLT registration lead time |
| D11 | Hosting | **DigitalOcean** (or your preference): managed PostgreSQL + Redis, Spaces, one app VM/App Platform | Simple, low cost for one city. The design is portable to AWS/Azure. |
| D12 | Existing sessions at cut-over | **Sign everyone out once** (don't migrate refresh sessions) | Simpler and safer. Users sign in again. |

Open questions Q1–Q9 are listed in [01-requirements-and-scope.md §1.3](01-requirements-and-scope.md#13-open-questions). Q1 (is there live production data?) has the biggest effect on the plan.

## Next phase (after approval)

**Phase 2: UI/UX and theme**
- Wireframes for the new screens (05 §5.3).
- Dark theme tokens and `ThemeService`.
- The `BbDialog` (CDK) facade and toast host, proved on one customer dialog.
- A NexPrime component API check (inputs and outputs read from the installed type definitions) for every component in the migration table.

No backend code until Phase 3.
