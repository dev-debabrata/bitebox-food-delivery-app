# BiteBox Master Prompt: Django Backend Migration and Platform Completion

> Give this whole file to the AI agent at the start of each work session, together with `CLAUDE.md`.
> **Part A** describes the BiteBox project as it exists today (analysed November 2026).
> **Part B** is the master requirements prompt, changed where it conflicts with the existing project.
> If Part A and Part B disagree, **Part A wins**. Raise the conflict in the next phase report rather than resolving it silently.

---

# PART A: THE EXISTING PROJECT (READ FIRST)

## A1. What already exists

BiteBox is **not a new project**. A complete food delivery platform is already built and tested in this repository:

| Area | Current implementation |
|---|---|
| Frontend | `frontend/`: Angular 22 (standalone, signals, OnPush, zoneless), SSR plus prerender, PWA (service worker, offline pages, install banner, Web Push), Signal Forms in 61 files, **no Reactive Forms**, NexPrime plus **Angular Material (imported in 107 files)**, Leaflet plus OpenStreetMap, `socket.io-client` |
| Backend | `backend/`: Node.js plus Express 5 (ES modules), Mongoose 9, Socket.IO, JWT access tokens plus a rotating refresh-token cookie, express-validator, pino, Swagger UI, Web Push (VAPID), Razorpay plus a mock provider, Cloudinary or local disk, SMTP |
| Database | MongoDB 7+ (single-node replica set in Docker, so transactions work), 23 models |
| Tests | 24 backend test files (about 350 tests, in-memory MongoDB) and Vitest frontend specs |
| DevOps | `docker-compose.yml` (mongo, api, web SSR, nginx), `deploy/nginx.conf`, `.github/workflows/ci.yml` (lint, test, build), Vercel config |
| Docs | `README.md`, `docs/DOCUMENTATION.md` (the full reference: data model, business rules, endpoints, screens), `docs/TROUBLESHOOTING.md`, `docs/COINS_REWARDS_PLAN.md`, Swagger at `/api/docs` |

**Four panels are live:** customer (`/`), restaurant (`/restaurant`), delivery (`/delivery`) and admin (`/admin`, with per-permission guards).

## A2. Business rules that the Django backend must preserve exactly

The Node backend is the **functional specification**. Port its behaviour, not just its endpoints. The sources of truth are listed below.

- **Roles** (`backend/config/roles.js`): `customer`, `restaurant`, `delivery`, `admin` (super admin), `operations_admin`, `finance_admin`, `support_admin`.
- **Admin permissions** (`backend/config/permissions.js`): `admins:manage`, `users:manage`, `audit:view`, `catalog:manage`, `operations:view`, `orders:view`, `orders:manage`, `restaurants:manage`, `riders:manage`, `finance:view`, `refunds:manage`, `payouts:manage`, `support:manage`, `reviews:moderate`, `rewards:manage`, `rewards:view`, `promotions:send`. The role-to-permission map must be identical. The super admin has every permission.
- **Order statuses** (`backend/models/order.model.js`): `pending → confirmed → preparing → ready_for_pickup → assigned → picked_up → on_the_way → delivered`, plus the final states `rejected` and `cancelled`.
- **Transition table** (`backend/services/order-workflow.service.js#TRANSITIONS`): this gives the allowed actor per move.
  - Status writes are conditional ("still in status X"). The loser of a concurrent update gets 409 `ORDER_CHANGED`. Repeating the same move is a no-op.
  - Side effects (coupon release, payment settlement, freeing the rider, coins) are idempotent.
  - Status changes happen in one service only.
- **Pricing** (`backend/config/pricing.js`): delivery fee ₹25 for the first 2 km, then ₹8 per extra km, capped at ₹99. Delivery is free at ₹499 or more after the discount. Platform fee ₹5. GST on food 5%. Delivery radius 15 km.
- **Dispatch** (`backend/config/dispatch.js`):
  - The nearest eligible rider gets the offer, one rider at a time.
  - A rider has 90 s to accept an offer. Riders must be within 10 km of the restaurant, and their location must be under 15 minutes old.
  - An unpaid online order is cancelled after 15 minutes. A restaurant that doesn't respond within 10 minutes auto-rejects. An order not picked up within 30 minutes is cancelled.
  - A sweep runs every 15 s.
- **Earnings** (`backend/config/earnings.js`): restaurant commission is 15% of food value after the coupon. A rider earns ₹20 plus ₹6 per straight-line km. Settlement is stored on the order at delivery.
- **Payments:**
  - Online orders stay invisible to restaurants (`submittedAt: null`) until paid.
  - Webhooks are verified on the raw body and applied once (`processedEvents`).
  - The mock provider is never available in production.
- **Data scoping:**
  - Partner and rider endpoints resolve their scope from the authenticated user and never trust ids from the client.
  - `presentForRestaurant` hides the customer's phone and exact address.
  - `presentForRider` reveals the full address only once the rider is carrying the order.
- **Coins ledger:**
  - Wallet changes go through `credit`, `reserve`, `commit`, `release`, `refund`, `reverse` and `expire`, each with a deterministic idempotency key.
  - Ledger rows are immutable.
  - Reward events are best-effort and never fail the caller.
- **Auth:**
  - The access token is held in memory only.
  - The refresh token is an HttpOnly cookie scoped to `/api/v1/auth`, rotated with family-based reuse detection.
  - Every request re-loads the user and checks `status` and `tokenVersion`, so suspensions and password changes apply immediately.
- **Audit log:** every data-changing admin action is recorded after a successful response.
- **Distances:** each distance is labelled as straight-line, road estimate or live GPS. Keep these distinctions.
- **Upstream geo services:** Nominatim and OSRM are cached, identical in-flight requests are merged, calls are limited to about 1 request per second, and failures degrade to a 503.

Read `docs/DOCUMENTATION.md` §8 to §14 before designing each Django app.

## A3. Gap analysis: master prompt vs. current project

| Master prompt requirement | Status in BiteBox | Action |
|---|---|---|
| Django + DRF + Channels + Celery backend | Node/Express + Socket.IO + in-process `setInterval` sweeps | **Rebuild** (main goal) |
| PostgreSQL + UUID keys | MongoDB + ObjectIds | **Rebuild**, plus a one-off data migration script |
| NexPrime only, no Angular Material | Material in 107 files | **Migrate** screen by screen to NexPrime, where NexPrime has the component |
| Signal Forms only | Already true | Keep. Add tests. |
| Mobile number + OTP login, email verification | Email + password only, reset by email | **Add** |
| Restaurant KYC: GST, FSSAI, bank details, documents, hours, holidays | Basic profile, approval states `pending/approved/rejected/suspended`, a single opening/closing time | **Add** |
| Food variants, add-ons, stock, multiple images | Single price, availability flag, one image | **Add** (cart, pricing and order snapshots must carry them) |
| Rider KYC: licence, RC, ID, bank, photo | Vehicle type and number only | **Add** |
| Delivery OTP, "arrived at restaurant" | Not present | **Add** (extends the transition table) |
| Partial refunds, invoices, restaurant settlement history | Full refunds, payouts | **Add** |
| SMS, email templates, FCM | SMTP mail, Web Push (VAPID), in-app inbox | **Add** SMS and templates behind adapters. **Keep** Web Push for the PWA. Add an FCM adapter for future native apps. |
| Light/dark theme | Check `src/styles.scss` | Add if missing |
| Coins, referrals, special rewards, newsletter, review moderation, support tickets, push promotions | **Exist** (not in master prompt) | **Port. Do not drop.** |
| Multi-project Angular workspace (`projects/customer-app`…) | Single app, lazy feature routes per panel | **Keep the single app.** Splitting it adds cost without benefit. Revisit only when native apps start. |
| Cloudinary or local disk | Exists | Move to an S3-compatible adapter (django-storages). Keep a local-disk dev/test backend. |
| Sentry, Prometheus/Grafana, backups | pino logs, health endpoint | **Add** |

## A4. Migration strategy (mandatory)

1. **Build alongside, not in place.** Create the Django project in a new top-level `backend-django/` folder. The Node `backend/` keeps running and stays the reference until the switch-over is approved.
2. **Keep the API contract stable** so the Angular app needs minimal change:
   - Same base path `/api/v1/`, same resource paths and same JSON field names (camelCase, e.g. `pricePaise`).
   - Same response envelope `{ success, message, data }`, same 422 validation shape `{ field: 'a.b' }` (the frontend's `serverErrors()` relies on it) and same error codes (`ORDER_CHANGED`, etc.).
   - Use a DRF renderer, exception handler and camelCase parser to achieve this.
   - New endpoints from Part B may be added. Renaming existing ones requires approval.
3. **Parity tests first.** For each module, port the matching Node tests (`backend/tests/*.test.js`) to pytest before or alongside the implementation. A module is "done" only when its ported tests pass.
4. **Realtime:** Channels uses plain WebSockets, not the Socket.IO protocol.
   - Keep the event names and payloads: `order:updated`, `order:location`, `notification:new`, `rider:location`, `track:join`, `track:leave`.
   - Replace `socket.io-client` in `core/services/realtime.service.ts` with a native WebSocket client that has reconnection, a heartbeat and token refresh on handshake failure.
5. **Background loops:** move the dispatch sweep, payment-window expiry and the rewards sweep to Celery Beat tasks. Keep `sweep(now)`-style pure functions so tests can call them directly.
6. **Money:** store amounts as integer paise (`BigIntegerField`) to keep the existing contract and exact arithmetic. This deviates from the master prompt's `DecimalField` rule, so ask for approval in Phase 1. If DecimalField is required, convert only at the API boundary.
7. **Data migration:** write an idempotent `manage.py import_mongo` command. It maps ObjectIds to UUIDs (keeping an `legacy_id` column) and verifies counts and money totals. Run it only against copies, never the developer's real `food_db`.
8. **Switch-over:** once every module passes, point the frontend and nginx at Django. Run both in staging. Keep Node deployable for rollback for one release. Then retire `backend/`.

## A5. Project rules from `CLAUDE.md` (they override Part B)

- Work **one phase at a time**. Report at the end and wait for explicit approval before the next phase.
- Angular components always use separate `.ts`, `.html` and `.scss` files. No inline templates or styles.
- Never write test or scratch data to the developer's real database.
  - Django tests use pytest-django with a throwaway test database (name ends in `_test`).
  - Browser end-to-end checks use a throwaway API on another port.
- Never print values from any `.env` file.
- Don't commit unless asked.
- Seeds and tests use **fictional** names, places and data only (e.g. `@bitebox.test` accounts, *Spice Route Kitchen*).
- Frontend: always use the npm scripts (they set `NG_BUILD_SASS_EMBEDDED=0`), never a bare `ng`.
- Keep SSR safety (no `window`/`localStorage` outside `isPlatformBrowser`/`afterNextRender`).
- Keep the PWA rules: only the public catalogue API is cached, and NexPrime stays out of the eagerly loaded bundle.

---

# PART B: MASTER REQUIREMENTS (adapted for BiteBox)

## 1. Project objective

Act as a Senior Software Architect, Product Manager, UI/UX Designer, Angular Developer, Python Django Backend Developer, Database Architect, QA Engineer, Security Engineer and DevOps Engineer.

Complete BiteBox as a scalable, secure, production-ready food delivery platform. It has four user types: **Customers, Restaurants, Delivery Partners and Admins** (super admin plus operations, finance and support staff).

Build a real working application, not a prototype. All screens, APIs, database operations, auth, payments, orders, delivery, notifications and admin operations must be integrated.

If an external service is not configured, use a **clearly labelled development mock adapter**, never available in production, and document how to configure the real provider.

## 2. Technology stack

### A. Frontend (existing; evolve it)
- Angular 22, TypeScript, standalone components, Router, Signals, **Signal Forms**, HttpClient, RxJS, functional guards and interceptors, SCSS, responsive layouts, lazy loading, SSR, PWA.
- **NexPrime** (`npm install nexprime`, already installed) is the primary UI library.
  - Use its buttons, inputs, selects, dialogs, tables, cards, alerts, badges, icons and so on.
  - Use the NexPrime theme with **light and dark themes**.
  - Follow the actual exported APIs in `node_modules/nexprime`. Do not invent selectors, inputs or imports.
- **Angular Material removal:** replace Material usages with NexPrime screen by screen.
  - Where NexPrime has no equivalent (check first; e.g. overlay dialog or snackbar), keep `@angular/cdk` primitives with custom SCSS.
  - List every remaining Material import in each phase report.
  - Do not add Bootstrap or any other UI framework.
- **Signal Forms only:** `form()`, `required()`, `email()`, `minLength()`, `maxLength()`, custom and cross-field validators, submission state.
  - Never use `FormGroup`, `FormControl`, `FormBuilder`, `FormArray` or `ReactiveFormsModule`, including in tests.
  - Reuse `shared/forms/form-rules.ts`, `NP_FORM_FIELDS`, `shownError()` and `serverErrors()`.
  - If a Signal Forms capability is missing, document it and use a signal-based workaround.
  - Signal Forms apply to: login, register, OTP, forgot/reset password, profile, addresses, checkout, restaurant registration and KYC, menu (variants and add-ons as dynamic fields), rider registration and KYC, admin management, coupons and support.

### B. Backend (new: `backend-django/`)
- Python 3.12+, Django 5.x LTS, Django REST Framework, Simple JWT (with the cookie refresh flow from A2), Django Channels (ASGI, Redis channel layer), Celery plus Redis (workers and Beat), django-filter, drf-spectacular (OpenAPI/Swagger), django-storages, Argon2 password hashing, pytest plus pytest-django, factory_boy.
- **Do not use** FastAPI, Flask, SQLAlchemy, or Pydantic as the validation layer.
- Django ORM, Django migrations, DRF serializers for validation and output, thin views, business logic in `services.py`, reads in `selectors.py`, custom permissions, central exception handler, pagination, filtering, consistent envelope.
- Use `transaction.atomic()` with `select_for_update()` or conditional `UPDATE ... WHERE status = X` for order, payment, dispatch-lock and wallet operations.
- Bcrypt hashes migrated from MongoDB must still verify. Enable Django's bcrypt hasher as a fallback and re-hash to Argon2 on login.

### C. Database
PostgreSQL 16+, Redis 7+, UUID primary keys, foreign keys, constraints, indexes, transactions, UTC timestamps, and PostGIS or `cube/earthdistance` for nearest-rider and radius queries (choose one in Phase 1 and justify it). Money is integer paise (see A4.6).

### D. Infrastructure
Docker, Docker Compose (postgres, redis, django-asgi, celery-worker, celery-beat, web SSR, nginx), GitHub Actions, S3-compatible object storage, environment-based settings (`base`, `development`, `staging`, `production`, `test`).

### E. Integrations (each behind an adapter)
Razorpay (existing; Cashfree optional), Leaflet plus OpenStreetMap, Nominatim and OSRM with configurable URLs and rate limits, Web Push (VAPID, existing) plus FCM for future native apps, MSG91 or another SMS provider, SMTP/AWS SES, Sentry, Prometheus plus Grafana. Google Maps and paid map APIs must not be mandatory dependencies.

Verify version compatibility between all dependencies before implementation.

## 3. Four panels: features

Items marked **(exists)** must be preserved. Everything else is new or extended work.

### A. Customer
- **Auth:**
  - Register and email + password login (exists).
  - **Mobile number + OTP login** (expiry, attempt limits, resend cooldown).
  - **Email verification.**
  - Forgot/reset password (exists).
  - JWT plus refresh rotation and logout (exists).
- **Location:**
  - Geolocation with permission, manual pin (map picker, exists), address search (Nominatim, exists).
  - Up to 10 saved addresses with Home/Work labels (exists).
  - Serviceability check, distance and delivery fee (exists).
- **Home:**
  - Location selector, search, categories, featured, popular and offer restaurants, recommended food, **recently ordered**, **banner management** (admin-controlled), open/closed status.
- **Restaurant list:**
  - Logo, cover, rating, cuisine, delivery estimate, minimum order, delivery charge, search, sort, filters, open/closed.
- **Menu:**
  - Categories, images, descriptions, prices, veg/non-veg, availability, **variants, add-ons**, quantity, special instructions.
- **Cart:**
  - Add, remove, update quantity, add-ons, subtotal, coupon, coins (exists), taxes, delivery fee, platform fee, total.
  - Everything is re-validated server-side.
- **Checkout:** address, delivery instructions, contact number, coupon, coins, online payment or COD, confirmation.
- **Orders:**
  - Live status and timeline, rider assignment, live tracking, ETA (labelled as an estimate), history.
  - **Reorder.**
  - Cancellation (exists, while pending).
  - **Refund tracking.**
  - **Delivery OTP shown to the customer.**
- **Account:**
  - Profile, addresses, **favourite restaurants and food**, order and **payment history**, coupons.
  - Reviews and ratings (exists), coins and referrals (exists), support tickets (exists), notifications inbox and push settings (exists).

### B. Restaurant
- **Registration and KYC:** name, owner, email, phone, address with map pin, **GST (optional), FSSAI licence, bank account, KYC documents, photos, weekly operating hours, holidays**.
- **Approval:** `pending → approved / rejected / needs_resubmission → suspended`, with a reason. Documents can be resubmitted.
- **Dashboard:** today's and total orders, revenue, pending, completed and cancelled orders, average order value, rating (exists, extend).
- **Menu:**
  - Category CRUD.
  - Food CRUD with image upload, variants, add-on groups (min/max selection), pricing, **stock**, availability toggle, veg/non-veg.
- **Orders:**
  - Live board with a new-order chime (exists), accept or reject with a reason, preparation time, preparing, ready, **handover confirmation** (rider pickup), history.
  - A cancellation appears in real time.
- **Settings:** open/closed toggle, business hours, holidays, delivery radius (up to the platform maximum), minimum order, preparation time.
- **Finance:** sales, commission, taxes and adjustments, refund deductions, **settlement history**, payout status, **downloadable invoices (PDF)**, sales reports.

### C. Delivery partner (mobile-first PWA, ready for native apps)
- **Registration and KYC:** name, mobile, email, photo, address, **driving licence, vehicle RC, identity document, bank account**, KYC status.
- **Dashboard:** online/offline toggle (exists), today's earnings, deliveries, pending offer, completed, **incentives**.
- **Assignment:**
  - Offer with pickup restaurant, drop area, distance (straight-line or road, labelled), estimated earnings, accept or reject.
  - 90 s timeout and automatic reassignment (exists).
- **Workflow:**
  - Navigate to the restaurant (external map link), **arrived at restaurant**, confirm pickup, navigate to the customer.
  - Live GPS (exists), contact the customer through a masked or relay number if available (otherwise show the number only while carrying the order).
  - **Delivery OTP**, complete.
- **Finance:** daily and weekly earnings, incentives, history, payouts, bank account.

### D. Admin (permission-based; preserve the existing staff roles)
- **Dashboard:** customers, restaurants, riders, total, active, completed and cancelled orders, GOV, platform revenue, pending settlements.
- **Customers:** list, detail, search, status, suspend/reactivate, order history.
- **Restaurants:** onboarding, **KYC document review**, approve, reject or request resubmission, **per-restaurant commission**, suspend, performance, settlements.
- **Riders:** list, **KYC review**, approve, online status, active deliveries, history, payouts, suspend.
- **Orders:** all orders, detail, timeline, **manual assignment**, reassignment/unassign (exists), cancel, refunds (**full and partial**), **disputes**.
- **Payments:** transactions, status, failures, refunds, **reconciliation against the gateway**, settlement reports.
- **Coupons:** create, edit, delete, percentage or fixed, minimum order, maximum discount, usage limit, per-user limit, validity dates, restaurant-specific (exists, extend).
- **Commission and fees:** global and per-restaurant commission, delivery fee slabs, platform fee, taxes. **Move the values in `config/pricing.js` and `config/earnings.js` into an admin-editable `app_settings` table with an audit trail.** Order snapshots keep the values in effect at the time of the order.
- **Support:** complaints from customers, restaurants and riders, tickets, assignment, priority, resolution, internal notes hidden from requesters (exists).
- **Security:** staff admins and permissions (exists), audit log (exists), **login history**, **system settings and feature flags**.
- **Existing extras to keep:** coins and rewards configuration, special-reward campaigns, referrals, push promotions, review moderation, newsletter.

## 4. Django backend architecture

Build a modular monolith with one Django app per business area. **Merge apps where the prompt over-splits them** (e.g. variants and add-ons belong in `menus`; ratings belong in `reviews`; refunds belong in `payments`). No empty or duplicate apps.

Suggested apps: `accounts` (users, sessions, OTP, login history), `rbac`, `customers` (profile, addresses, favourites), `restaurants` (profile, KYC documents, hours, bank), `menus` (categories, items, variants, add-ons, images, stock), `cart`, `pricing`, `coupons`, `orders` (orders, items, workflow, status history, cancellations), `dispatch`, `delivery` (partners, KYC, vehicles, assignments), `tracking`, `payments` (payments, attempts, webhooks, refunds, reconciliation), `finance` (commission rules, settlements, rider payouts, ledger entries, invoices), `coins` (wallet, ledger, referrals, campaigns), `reviews`, `support`, `notifications` (in-app, email, SMS, push, templates, preferences, device tokens, delivery logs), `geo` (geocoding and routing adapters), `analytics` (reports), `audit`, `system_settings` (settings, feature flags, banners), `newsletter`, `uploads`.

Each app contains, where needed: `models.py`, `serializers.py`, `views.py`, `urls.py`, `services.py`, `selectors.py`, `permissions.py`, `tasks.py`, `consumers.py`, `admin.py` and `tests/`.

Business logic stays out of views and serializers.

## 5. Database design (PostgreSQL)

- Normalised schema, UUID primary keys, foreign keys, unique constraints, check constraints (e.g. non-negative money, valid status values), indexes on frequently searched columns, UTC timestamps.
- Order item **price snapshots** (item, variant and add-ons), plus an address snapshot and a restaurant snapshot.
- Status history tables for orders, payments and deliveries.
- Soft delete only for menu items and restaurants.
- Unique constraints on gateway order/payment ids, webhook event ids, order idempotency keys and coin ledger idempotency keys.
- Table groups:
  - **Identity:** users, roles, permissions, role_permissions, sessions, otp_verifications, login_history.
  - **Customer:** addresses, favourites.
  - **Restaurant:** restaurants, documents, hours, holidays, bank accounts.
  - **Menu:** categories, items, images, variants, add-on groups, add-ons.
  - **Cart:** carts, items, item add-ons.
  - **Order:** orders, items, item add-ons, status history, cancellations.
  - **Payment:** payments, attempts, webhook events, refunds, invoices.
  - **Delivery:** partners, documents, vehicles, assignments (offers), tracking points (retention-limited).
  - **Promotion:** coupons, redemptions, banners, campaigns.
  - **Coins:** wallets, ledger, batches, referrals, campaign claims.
  - **Review:** reviews, responses, reports.
  - **Finance:** commission rules, settlements, rider payouts, ledger entries.
  - **Support:** tickets, messages.
  - **Notifications:** notifications, templates, push subscriptions and device tokens, delivery logs.
  - **System:** audit logs, app settings, feature flags, newsletter.
- Deliver: an ER diagram (Mermaid), table specifications (columns, types, keys, relationships), the indexing strategy, and the **MongoDB to PostgreSQL field mapping** for every existing model.

## 6. Order lifecycle

Full flow: select restaurant → cart → backend validates availability, prices, tax and fees → address → place order (idempotent) → pay (online) or COD → payment verified server-side → restaurant notified → accept/reject → preparing → ready → dispatch finds the nearest eligible rider → offer → accept → **arrived at restaurant** → pickup (handover confirmation) → live tracking → **delivery OTP** → delivered → settlement recorded → review.

- Extend the existing transition table (A2) for the new steps rather than replacing it. Propose the new table in Phase 1.
- Keep the order, payment and delivery statuses independent.
- **Exception paths:** payment failure or timeout, duplicate webhook, restaurant rejection or timeout, customer cancellation, rider rejection or timeout, rider going offline mid-delivery, reassignment, delivery failure (customer unreachable), full or partial refund, network interruption (clients re-read state over REST after reconnecting).

## 7. REST API (`/api/v1/`)

- Keep every existing endpoint listed in `docs/DOCUMENTATION.md` §14 with the same paths and payloads.
- Add the endpoints the new features need (OTP, KYC documents, variants and add-ons, favourites, reorder, delivery OTP, arrival, invoices, partial refunds, reconciliation, settings, banners, login history).
- The example endpoint list in the original master prompt is a guide only. **Existing BiteBox paths win** (e.g. partner endpoints stay under `/my/restaurant`, rider endpoints under `/delivery`).
- Document every endpoint with drf-spectacular: method, URL, auth, required role or permission, request and response schemas, validation rules, status codes and examples. Serve Swagger at `/api/docs`.

## 8. Real-time (Django Channels plus Redis)

- Authenticated WebSocket connections (access token in the first message or a subprotocol, never in a logged query string).
- Rooms come only from server-side identity (`user:<id>`, `restaurant:<id>`, `admins`) plus `order:<id>` after a database permission check.
- Covered flows: new order to the restaurant, status updates to the customer, offers to the rider, rider location to the customer and admins, cancellations to the restaurant, active-order monitoring for admins.
- Events carry ids, statuses and timestamps only. Clients re-read over REST and drop duplicate events.
- `rider:location` is validated, rate-limited, checked for implausible speed and flagged as stale when old.
- Heartbeat and reconnection. Works across multiple ASGI instances through the Redis channel layer.

## 9. Payments

- Provider abstraction: Razorpay, plus the mock provider in development only (as today).
- Covers: create, verify signature, success, failure, timeout, webhook (raw-body signature, unique event id, idempotent), refund (full and partial), refund status, reconciliation job, history, COD.
- Never trust the frontend's success signal. Never store card data. Keep a financial audit trail.

## 10. Maps and delivery tracking
- Leaflet plus OpenStreetMap tiles (exists).
- Nominatim and OSRM behind adapters with configurable URLs, caching, merging of identical requests and about 1 request per second (the usage policy). Never assume public endpoints offer unlimited production use; document self-hosting.
- Navigation uses external links. ETAs are labelled as estimates. Never promise delivery times from distance alone.
- **Dispatch eligibility:** online, approved, KYC-verified, fresh location, within radius, no active order or offer, vehicle eligible.

## 11. Notifications
- A central `notify()` service with channels for in-app (exists), Web Push (exists), FCM (adapter), email (templates) and SMS (adapter).
- Templates, per-user preferences (`orders`, `promotions`, `account`, plus per-channel settings), Celery delivery with retries, delivery status logs and dead-letter handling. Notification failures never fail the caller.
- **Events:** registration, OTP, order placed, payment success/failure, accepted, rejected, preparing, ready, rider assigned, picked up, rider approaching, delivered, cancelled, refund initiated/completed, settlement processed, KYC approved/rejected.

## 12. Security
JWT with refresh rotation and reuse detection, Argon2id, RBAC plus resource-level checks, OTP expiry and attempt limits, rate limiting (auth, OTP, location), HTTPS, strict CORS, CSRF on cookie-authenticated endpoints, input validation, ORM-only queries, XSS-safe output, secrets from the environment, webhook verification, audit logging, encryption of sensitive fields (bank account numbers, document numbers), secure uploads (magic-byte type checks, size limits, private document bucket with signed URLs), session revocation, dependency scanning (pip-audit, npm audit), SSRF guard on push endpoints.

## 13. UI/UX
- Modern NexPrime design with light and dark themes and consistent `--bb-*` tokens.
- Mobile-first for customers and riders. Desktop-optimised restaurant and admin panels.
- Reuse and extend the existing shared components (panel shell, daily chart, stat tile, confirm dialog, paged list, map picker, tracking map, notification bell).
- Skeletons, empty and error states, keyboard navigation, WCAG 2.1 AA. Realistic, **fictional** seed data. No lorem ipsum.

## 14. Testing
- **Backend (pytest):** unit, integration, API, model/constraint, webhook, authorisation (every role against every protected route), Celery tasks (eager mode), Channels consumers, concurrency (double accept, double pay, two riders accepting one offer). Include the ported Node parity suite.
- **Frontend (Vitest):** components, services, Signal Forms validation, guards, interceptors, realtime client.
- **E2E (Playwright, throwaway API and database):** full order flow, rejection, rider reassignment, payment failure, refund, delivery OTP.
- **Performance:** load tests on checkout, dispatch and WebSockets (k6 or Locust), query plans for hot paths.
- **Security:** access-control matrix, injection, XSS, CSRF, auth bypass, rate limits, data exposure.

## 15. Project structure

```text
bitebox-angular-python/
├── frontend/                 # existing Angular 22 app (single app, lazy panels)
├── backend/                  # existing Node API: reference until switch-over, then removed
├── backend-django/
│   ├── config/settings/{base,development,staging,production,test}.py
│   ├── config/{urls,asgi,wsgi,celery}.py
│   ├── apps/<app>/…          # see section 4
│   ├── common/{permissions,exceptions,pagination,renderers,validators,utils}/
│   ├── integrations/{payments,geo,sms,email,push,storage}/
│   ├── scripts/              # seed, import_mongo
│   ├── requirements/{base,dev,prod}.txt
│   ├── .env.example
│   ├── manage.py
│   └── Dockerfile
├── deploy/                   # nginx, env templates
├── docs/
└── docker-compose.yml
```

## 16. DevOps
Dockerfiles, Compose for development and production, nginx (WebSocket upgrade for `/ws/`), migrations run before release, Celery worker and Beat, Daphne or Uvicorn ASGI, CI (ruff, pytest, frontend tests and build, pip-audit, npm audit), health and readiness checks, Sentry, Prometheus metrics, structured logs, automated PostgreSQL backups with a **tested** restore, and a rollback plan (including falling back to the Node API during the transition). PostgreSQL and Redis are never publicly exposed.

## 17. Legal and business
Prepare configurable workflows and documentation for FSSAI, GST and tax handling, payment compliance, the privacy policy (DPDP Act 2023), terms, refund, cancellation and delivery policies, the grievance officer, partner and rider agreements, and the commission and settlement policy. **Flag all of these for review by qualified professionals.** Code alone does not make the platform compliant.

## 18. Development phases (adapted)

| Phase | Scope |
|---|---|
| 1 | Requirement analysis, gap confirmation, architecture, ER diagram, MongoDB→PostgreSQL mapping, API delta spec, risks (**the first task, below**) |
| 2 | UI/UX for new screens (OTP, KYC, variants/add-ons, delivery OTP, settings), NexPrime migration plan, light/dark theme |
| 3 | Django project skeleton, settings, Docker (postgres, redis), CI job, envelope, renderer and exception handler, health endpoint, OpenAPI |
| 4 | Models and migrations for existing features (parity schema), seed command |
| 5 | Auth and RBAC parity (JWT, refresh cookie, sessions, permissions, audit), then OTP login and email verification |
| 6 | Catalogue, restaurants, menus, cart, pricing, coupons, addresses (parity, then variants, add-ons and stock) |
| 7 | Orders, workflow, dispatch (Celery Beat sweep), Channels realtime, frontend WebSocket client |
| 8 | Payments, refunds (including partial), webhooks, reconciliation |
| 9 | Coins, referrals, rewards, reviews, support, notifications (email, SMS and FCM adapters), newsletter, push |
| 10 | Finance: settlements, payouts, invoices, reports, editable commission and fee settings |
| 11 | KYC for restaurants and riders, document storage, admin review screens |
| 12 | Delivery OTP, arrival step, reorder, favourites, banners, login history, feature flags |
| 13 | Angular Material → NexPrime migration completed |
| 14 | MongoDB data import and verification on a copy, staging switch-over, E2E and load tests |
| 15 | Security audit, monitoring, backups and restore drill |
| 16 | Production cut-over, retire `backend/`, final documentation |

## 19. Rules for the AI

1. Analyse first. Don't generate files at random.
2. Use Django, Django ORM and DRF serializers, not FastAPI, SQLAlchemy or Pydantic.
3. Use Angular 22, NexPrime, Signals and Signal Forms. Never use Reactive Forms. Never add new Angular Material usages.
4. Validate every price and business rule on the backend. Never trust client prices or payment status.
5. Authorise every protected resource, with both role and ownership checks.
6. Use transactions and locking for critical writes.
7. Write tests alongside the code. A feature is not done until its tests pass.
8. Never claim an integration works without real configuration and verification. Mocks are labelled and blocked in production.
9. Keep `README.md`, `docs/DOCUMENTATION.md`, `CLAUDE.md` and `.env.example` files up to date. Never put real secrets in them.
10. Use Django migrations only. No manual schema changes.
11. Follow official Angular, Django, DRF, Channels, Celery and NexPrime documentation.
12. Don't over-abstract or duplicate. Reuse the existing frontend services and components.

## 20. Deliverables and definition of done

Deliverables:
- Django source code, migrations, OpenAPI docs and ER diagram.
- The updated Angular app (NexPrime, Signal Forms, WebSocket client).
- Payments, maps, notifications and real-time tracking.
- Test suites.
- Docker setup, CI/CD, and deployment, backup and recovery docs.
- A security checklist, user manuals, developer docs, a manager report and a production-readiness checklist.

**Done when:**
- All four panels work against the Django API, and the parity suite passes.
- No Reactive Forms exist, and the remaining Material usage is zero or justified.
- Customers can order, pay, track and review. Restaurants can accept and prepare. Riders can accept and deliver with OTP.
- Refunds are tested, and the admin can manage the whole platform.
- Migrations and constraints are verified, and the MongoDB data import is verified on a copy.
- The security review is complete, and agreed performance targets are met.
- Staging and production deployments succeed, monitoring and backups run, and restore and rollback have been tested.
- Legal review has been signed off.

---

# PART C: FIRST TASK

**Do not write application code yet.** Produce the Phase 1 deliverables and then stop for approval:

A. Requirement analysis: confirm or correct the gap table in A3 by reading the code, and list assumptions and open questions.
B. System architecture diagram (Mermaid): Angular SSR/PWA, nginx, Django ASGI, Celery, Redis, PostgreSQL, object storage, external providers.
C. Workflow diagrams: order lifecycle (with the new arrival and delivery-OTP steps), payment, dispatch, refund, KYC approval.
D. ER diagram (Mermaid).
E. Table specifications plus the **MongoDB → PostgreSQL mapping** for all 23 existing models.
F. API spec: the existing endpoints (unchanged) plus the new endpoints, with request and response shapes.
G. Frontend changes: the NexPrime migration inventory (Material usage per feature folder), the realtime client rewrite, and new screens.
H. `backend-django/` folder structure.
I. Milestones and task breakdown per phase (section 18).
J. Risk assessment and security plan, including migration risks (data import, Socket.IO→WebSocket, dual running, rollback).
K. MVP (parity plus switch-over) versus later releases (KYC, variants, OTP, SMS, invoices, FCM).
L. Signal Forms strategy (dynamic variant and add-on fields, OTP input, KYC uploads, cross-field rules).
M. DRF strategy: camelCase contract, envelope, error format, pagination, permissions (`can()` equivalent), audit decorator.
N. NexPrime strategy: what exists in the installed package, theme tokens, dark mode, bundle-size rule.
O. Leaflet + OpenStreetMap + geo adapter architecture, and the PostGIS vs. earthdistance decision.
P. Decisions needing approval: integer paise vs. DecimalField, single Angular app vs. multi-project workspace, new transition table, Cashfree yes/no, SMS provider, hosting target.

At the end of **every** phase report: files created or modified, features, APIs, database changes, tests run with results, pending tasks, known limitations, and the next phase plan. **Then wait for approval.**
