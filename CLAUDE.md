# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

BiteBox is a food delivery platform: an Angular 22 frontend (`frontend/`) and a Node/Express 5 + MongoDB backend (`backend/`, JavaScript ES modules). It has four role-based panels: customer, admin, restaurant and delivery. The README is the quick start; `docs/DOCUMENTATION.md` is the detailed reference for setup, endpoints, data model and business rules.

## Working agreement

- **Phases:** the project is built in phases (see the README status line). Implement only the current phase, report at the end, and wait for explicit approval before starting the next one.
- **Angular components:** always use separate `.ts`, `.html` and `.scss` files. Never write inline `template`/`styles`.
- **Forms:** use **Signal Forms** (`@angular/forms/signals`) with schema validation, not Reactive Forms. Inputs are **NexPrime** components (see Frontend below).
- **Database:**
  - Never write test or scratch data to the developer's real database (`MONGO_URI`, usually `food_db`).
  - Backend tests use an in-memory MongoDB, or `TEST_MONGO_URI`, whose database name must end in `_test`.
  - For browser end-to-end checks, run a throwaway API on another port against an in-memory MongoDB.
- **Secrets:** never print values from `backend/.env`.
- **Commits:** don't commit unless asked.
- **Sample data:** use only fictional names, places and data in seeds and tests.

## Commands

The developer usually keeps both dev servers running: the API on :5000 (`nodemon`) and the web app on :4200.

```bash
# Backend (cd backend)
npm run dev                      # API with nodemon, http://localhost:5000 (Swagger at /api/docs)
npm test                         # all tests (node:test, in-memory MongoDB, run serially)
NODE_ENV=test node --test --test-concurrency=1 tests/orders.test.js   # one test file
NODE_ENV=test node --test --test-name-pattern="dispatch" tests/orders.test.js  # matching tests only
npm run lint                     # eslint
SEED_PASSWORD='Dev-pass-123' npm run seed   # idempotent dev data (refuses NODE_ENV=production)

# Frontend (cd frontend). The scripts set NG_BUILD_SASS_EMBEDDED=0, because the embedded
# Dart Sass process gets killed on this machine (the build hangs on "Building...").
# Always use the npm scripts, not a bare `ng`.
npm start                        # dev server, http://localhost:4200
npm run build                    # production build (SSR output in dist/frontend)
npm test -- --watch=false        # all unit tests (Vitest via @angular/build:unit-test)
npm test -- --watch=false --include src/app/core/services/rider-gps.service.spec.ts   # one spec
npx ng build --configuration development   # fast type/template check (prefix NG_BUILD_SASS_EMBEDDED=0 if it hangs)
```

```bash
# Django API (cd backend-django), replacing backend/ phase by phase (docs/django-migration/)
.venv/bin/pytest                  # tests (config.settings.test; TEST_DATABASE_URL must end in _test, else in-memory SQLite)
.venv/bin/ruff format . && .venv/bin/ruff check . && .venv/bin/mypy .
.venv/bin/uvicorn config.asgi:application --reload --port 8000   # API on :8000 (Node keeps :5000)
```

Production: `docker compose --env-file deploy/.env up -d --build` (see `docs/DOCUMENTATION.md` §19). CI is `.github/workflows/ci.yml`. Problems and fixes: `docs/TROUBLESHOOTING.md`.

## Backend architecture (`backend/`, no `src/` folder)

- **Layering:** routes → `validate(...)` (express-validator) → controllers → services → Mongoose models.
  - `validate` puts the sanitised body in `req.body` and the query in `req.validatedQuery`, built from `matchedData`, so unknown fields are dropped.
  - Every response uses the envelope `{ success, message, data }` (`utils/api-response.js`).
  - Throw `ApiError` (`utils/api-error.js`) for client-visible errors. Anything else becomes a generic 500.
- **Auth:**
  - Short-lived JWT access tokens are kept only in browser memory.
  - A rotating refresh token lives in an HttpOnly cookie scoped to `/api/v1/auth`.
  - `authenticate` re-loads the user on every request and checks `status` and `tokenVersion`, so suspensions and password changes apply immediately. `authorize(...roles)` restricts by role.
  - Partner and rider endpoints (`/my/restaurant`, `/delivery`) resolve their scope from `req.user` and never trust ids from the client.
  - **SMS codes:** `services/otp.service.js` (Django `apps/accounts/otp.py`) for phone sign-in, sign-up (`/auth/register/code`, then `register` with `code` while `signupNeedsCode()`) and number verification: HMAC-stored 6-digit codes, 5 tries, resend wait and hourly limits, sent with `notification-channels.js#deliverSms` (the console provider prints the code in development). Numbers match in any stored form (`phoneForms`). Email verification links are sent on registration. Tests switch the sign-up code with `useSignupCode(true)` (Django: `settings.SIGNUP_OTP_REQUIRED`).
  - **Admin roles:** `admin` is the super admin; `operations_admin`, `finance_admin` and `support_admin` share the admin panel (`config/roles.js`). Admin routes use `can(PERMISSIONS.X)` from `config/permissions.js`, not `authorize(ROLES.ADMIN)`. Add a permission there (and to the frontend `Permission` type) rather than checking roles. Admin users carry `permissions` in their JSON.
  - **Audit log:** add `audited(action, resourceType, describe)` (`services/audit.service.js`) to admin routes that change data; it records after a successful response.
  - **Access matrix:** `tests/security-access.test.js` reads each route's guards from the route table (`tests/route-table.js`; `authorize`/`can` carry `roles`/`permissions`) and checks every role. A new public route must be added to its `PUBLIC` list (and to `backend-django/tests/test_access_control.py`). Django views are deny-by-default: public ones set `permission_classes = PUBLIC` (`common/permissions.py`).
- **Money:** always integer paise. Prices, fees, discounts and totals are computed server-side (`config/pricing.js`, `services/pricing.service.js`, the cart quote). Orders store snapshots of items, the address and the restaurant.
- **Multi-document writes:** use `utils/transaction.js#withTransaction`. It uses a transaction on replica sets (Atlas). Otherwise it calls `work(null)`, and the caller must undo completed steps itself; `order.service.js#placeOrder` is the reference pattern. `DISABLE_TRANSACTIONS=true` forces the fallback path.
- **Order lifecycle:** `services/order-workflow.service.js` is the single place where statuses change.
  - **Transition table:** `TRANSITIONS[from][to]` lists the allowed actor roles.
  - **Atomic writes:** `transition()` does a conditional update ("still in status X"). A concurrent loser gets 409 `ORDER_CHANGED`, and repeating the same move is a no-op.
  - **Side effects:** coupon release, payment settlement and freeing the rider live in `afterTransition`, and each is idempotent.
  - **Rule:** never set `order.status` anywhere else.
- **Dispatch:** `services/dispatch.service.js`.
  - **Matching:** nearest eligible rider via `$geoNear`. One rider is offered the order at a time, with a timeout.
  - **Locks:** `DeliveryPartner.currentOffer` and `activeOrder` are compare-and-set locks.
  - **Sweep:** `sweep()` runs on an interval started in `server.js`. It expires offers, re-dispatches waiting orders and auto-rejects unanswered ones. Tests call `sweep(now)` directly.
  - **Tunables:** in `config/dispatch.js`.
- **Payments:** `services/payments/`. `payment.service.js` owns every payment state change (start, confirm, webhook, mark paid/failed, refunds).
  - **Providers:** COD, Razorpay (`razorpay.provider.js`, only when both keys are set) or the simulated `mock.provider.js` (never in production). Swap in tests with `useOnlineProvider`.
  - **Visibility:** online orders have `submittedAt: null` until paid. Restaurant queries require `submittedAt`, and the response timer starts from it. The sweep cancels unpaid orders after `paymentWindowMinutes`.
  - **Settlement:** on delivery the workflow stores `order.settlement` from `earnings.service.js#settlementFor` (`config/earnings.js`). Earnings and admin reports (`reports.service.js`) aggregate it, grouping days in `env.reportTimezone`.
  - **Webhook:** mounted in `app.js` *before* `express.json`, because the signature covers the raw body.
- **Notifications:** `notification.service.js#notify(userIds, {...})` stores the notification, emits `notification:new` and plans one `NotificationDelivery` per external channel (Web Push, FCM, email, SMS; rules in `notification-channels.js`) that the type uses and the person allows (`pushPreferences`, `channelPreferences`; categories `orders` for `order.*`/`payment.*`, `promotions` for `promo.*`, `account` otherwise). Each delivery is attempted in the background; failures retry with back-off (`retryDue`, every minute) and become dead letters admins can retry. Best-effort, never throws. Push is off unless both `VAPID_*` keys are set; tests swap the push sender with `usePushSender`, other channels with `notification-channels.js#useChannel`, and await `flushPush()` (it waits for deliveries too). Subscription endpoints must be on `PUSH_ALLOWED_HOSTS` (SSRF guard). `notifyAdmins(payload, permission)` reaches the super admin plus every admin role with that permission.
- **Coins & rewards:** see `docs/DOCUMENTATION.md` §10.9 and `docs/COINS_REWARDS_PLAN.md`.
  - **Ledger:** only `services/coin-wallet.service.js` changes wallets: `credit`, `reserve`/`commitReservation`/`releaseReservation`/`refundRedemption`, `reverseCredit`, `expireBatch`. Every call needs a deterministic idempotency key (e.g. `order-reward:<orderId>`). Never write `CoinWallet` or `CoinTransaction` directly; ledger rows are immutable (model middleware rejects edits and deletes).
  - **Events:** order, review and sign-up events reach the programme only through `services/reward-events.js` (best-effort, logged, never fails the caller). Settings come from `reward-config.service.js#getRewardConfig()` (defaults in `config/rewards.js`).
  - **Sweep:** `rewards-jobs.service.js#rewardsSweep(now)`; tests call it directly.
- **Finance and support:** `services/finance.service.js` (dashboard, payouts claimed via `order.payouts.*`, refunds, commission rules via `earnings.service.js#commissionBpFor`, refunds after delivery reduce `settlement.refundAdjustmentPaise`), `services/ledger.service.js` (immutable double-entry rows, keyed per settlement/payout/refund; never write `LedgerEntry` elsewhere), `services/invoice.service.js` (PDF invoices and payout statements, numbered per financial year; served with `api-response.js#download`), `services/operations.service.js` and `services/support.service.js` (tickets; requesters never see internal notes). Status-change messages live in `order-notifications.js`, called from the workflow.
- **What each role sees:** `services/order-management.service.js` defines `presentForRestaurant` (no customer phone or exact address), `presentForRider` (full address only once carrying the order) and `presentWithRider` (customer and admin).
- **Realtime (Socket.IO):** `sockets/`, attached to the HTTP server in `server.js`.
  - **Handshake:** the client sends `auth.token` (the access token).
  - **Rooms:** they come only from the server-side identity (`user:<id>`, `restaurant:<id>`, `admins`) plus `order:<id>`. Tracking rooms are joined via `track:join` after a database permission check (`sockets/tracking.js`).
  - **Order events:** `emitOrderUpdated()` in `sockets/events.js` is called from the workflow, dispatch and order placement. Events carry ids and statuses only; clients re-read over REST.
  - **Rider positions:** `rider:location` is validated, rate-limited and checked for implausible speed, then broadcast to the active order's room.
  - **Tests:** when no server is attached, emits are no-ops.
- **External geo services:**
  - `services/geocoding.service.js` (Nominatim) and `services/routing.service.js` (OSRM, swappable via `useProvider`) share `utils/upstream.js#createUpstream`. It caches, merges identical in-flight requests and serialises about 1 request per second. Both fail with a 503 that the UI degrades on.
  - GeoJSON helpers (`toPoint`, `fromPoint`, `haversineMeters`) are in `utils/geo.js`. Order status groups (`ACTIVE_STATUSES`, `FINAL_STATUSES`, `TRACKED_STATUSES`) live next to `ORDER_STATUS` in `models/order.model.js`.
  - Distances are labelled as straight-line (fees and dispatch), road estimate (routing) or live GPS. Keep those distinctions.
- **Partner verification (KYC):** `services/kyc.service.js` (Django `apps/kyc`): documents per kind in private storage (`env.privateUploadDir`, served only by the API to the owner or a reviewing admin, admin views audited), numbers and bank accounts encrypted with `utils/field-crypto.js` (Django `common/crypto.py`; `FIELD_ENCRYPTION_KEY`), the checklist per role (`KINDS_FOR`, `requiredKinds`). Restaurants are approved only when `kycGaps()` is empty (`RESTAURANT_KYC_REQUIRED`; tests switch it with `useRestaurantKyc(true)`, Django `settings.RESTAURANT_KYC_REQUIRED`). Riders go online only once verified (`DeliveryPartner.verificationStatus`, `verificationOf()`; a missing status counts as approved; `RIDER_KYC_REQUIRED`, tests `useRiderKyc(true)`, Django `settings.RIDER_KYC_REQUIRED`). Frontend: `shared/components/kyc/*` (documents, bank account form, admin review), shared by restaurants and riders.
- **Images:** `services/upload.service.js#saveImage` checks the real file type from its bytes, strips EXIF/GPS metadata (`utils/image-metadata.js`, keeps the JPEG orientation), then stores it in Cloudinary (`config/cloudinary.js`, when the `CLOUDINARY_*` keys are set) or on local disk. Tests always use local disk; swap storage with `useImageStorage`.
- **API docs:** OpenAPI fragments in `docs/openapi.*.js`, merged in `docs/openapi.js`. Update them when routes change.

## Frontend architecture (`frontend/src/app`)

- **App shape:**
  - Standalone components, signals, `OnPush`, zoneless.
  - Lazy feature routes: `features/*/…routes.ts`, wired in `app.routes.ts`.
  - Panels use `layout/panel-shell`, with `NavItem.badge` for counts.
- **SSR:**
  - `src/server.ts` sends a Content-Security-Policy with a fresh nonce per rendered page; `index.html` carries the `CSP_NONCE` placeholder on its inline script and on `<app-root ngCspNonce>`. A new inline script needs `nonce="CSP_NONCE"`.
  - `app.routes.server.ts` sets the render modes. Home renders per request, the auth pages are prerendered, everything else is client-only.
  - Never touch `window`, `navigator` or `localStorage` outside `isPlatformBrowser` / `afterNextRender`.
  - Leaflet is imported dynamically inside `afterNextRender`.
- **Auth:**
  - Admin pages are guarded with `permissionGuard('perm')` and menus come from `layout/admin-layout` per role; use `auth.can('perm')` to hide actions a role can't use.
  - `core/auth/auth.service.ts` restores the session at startup and exposes `user`, `initialised` and `displayUser`, a display-only localStorage hint that avoids a reload flicker and must never be used for access decisions.
  - `core/interceptors/auth.interceptor.ts` adds the token, sends cookies only to `/auth/*`, and refreshes on 401.
  - **Node → Django switch:** `core/interceptors/api-router.interceptor.ts` (registered last) sends API paths listed in `environment.djangoRoutes` to `environment.djangoUrl` (Django, :8000); everything else stays on Node :5000. Add a phase's paths there once its Django endpoints pass their tests. In production nginx does this routing, so `environment.prod.ts` lists none. API base: `environment.baseUrl`.
  - **Live updates switch:** `environment.realtime` (`'node'` = Socket.IO, `'django'` = the Django `/ws/` WebSocket) picks the transport behind `RealtimeService` (`core/services/realtime-transport.ts`). Move it with `/auth`: the socket signs in with the same access token.
  - Pass `context: publicRequest()` on public catalogue calls so the SSR HTTP transfer cache can reuse them.
- **Live data:**
  - `core/services/realtime.service.ts` owns the socket: it connects while signed in, refreshes the token on handshake failure, and exposes `orderUpdates$`, `track(orderId)` and `sendRiderLocation()`.
  - Screens react to events with a slow fallback poll that pauses on hidden tabs. Use `core/services/poll.ts#liveRefresh(request, { pollMs, when })`, which wraps `pollWhileVisible`. A request passed to either must catch its own errors.
  - **Page loader:** `core/services/page-loader.ts` shows a top bar (in `app.html`) for every HttpClient request slower than 200 ms. Wrap background requests in `inBackground(request$)` so they don't show it; `poll.ts` already does this for repeat polls and live refreshes.
  - Paginated admin-style lists use `shared/list/paged-list.ts#pagedList(fetch, opts)`, which gives data, loading and error state, live refresh, and a reset to page 1 when the filters change.
  - Confirm-then-act flows use `confirmed(bbDialog, data)` from `shared/components/confirm-dialog/confirm-dialog.ts`, where `bbDialog = inject(BbDialog)`.
  - **Dialogs:** new and migrated dialogs use `BbDialog` (`shared/dialog/bb-dialog.ts`, CDK dialog, not `MatDialog`): `inject(BB_DIALOG_DATA)`, `inject(BbDialogRef)`, a `bbDialogTitle` heading, and `.bb-dialog__content` / `.bb-dialog__actions`. NexPrime has no programmatic dialog opener.
  - **Toggles:** bind `np-toggle [checked]` to the source state and update that state optimistically, restoring it on failure. Never call `toggle.checked.set()`: it re-emits `checkedChange`.
  - `core/services/restaurant-order-board.ts` is a shared ref-counted store for the restaurant panel.
  - `core/services/inbox.service.ts` backs the header bell (`shared/components/notification-bell`). `NotificationService` is the snackbar helper, not this.
  - **Payments:** `core/services/payment.service.ts#pay(orderId, session)` opens Razorpay checkout.js or the `MockPaymentDialog` and reports the result. Use `awaitingPayment()` / `customerStatusLabel()` from `checkout.models.ts` for unpaid online orders.
  - **Charts:** `shared/components/daily-chart` (np-chart plus a "Show as table" view, palette in `SERIES_COLORS`) and `shared/components/stat-tile`.
- **Forms:**
  - Use `form(model, schema, { submission: { action } })` with `<form [formRoot]>` and `[formField]`.
  - Reusable rules are in `shared/forms/form-rules.ts`. `shownError()` shows an error once the field is touched, and `serverErrors()` maps the API's 422 `{ field: 'a.b' }` errors onto fields.
  - Import `NP_FORM_FIELDS` (`shared/forms/np-form-fields.ts`), which bundles `FormField`, the NexPrime inputs, a touched-on-blur directive (NexPrime has no `touch` output), `NpInputAttrs` (forwards `autocomplete` and `inputmode`) and `<bb-field-error>`.
  - `np-text-input` takes `[error]`. Other NexPrime controls go in a `.bb-field` wrapper with `<bb-field-error>`.
- **UI:**
  - Angular Material (M3) plus NexPrime (`nexprime` package; npm `overrides` pin its Angular peers).
  - Brand tokens (`--bb-*`, NexPrime `--ui-*` mapped onto them) and global form and field rules live in `src/styles.scss`. NexPrime host widths are overridden there with `!important`, because their emulated host styles outrank element selectors.
  - **Dark theme:** `<html data-theme="dark">`, set by `core/services/theme.service.ts` (and an inline script in `index.html` before first paint). Never hard-code colours in component SCSS; use tokens. `--bb-plum` turns light lavender in dark mode (text and accents); fills that must stay plum use `--bb-brand` (text on them `--bb-on-brand`), text on amber uses `--bb-on-accent`, status tints use `--bb-{success,danger,warning,info,teal}-bg` with `-ink`/the status colour, and solid fills under white text use `--bb-{success,danger}-solid`.
  - **Buttons:** `np-button` for actions: set `severity` (it defaults to none, so the button gets no colour) and `label=""` plus `ariaLabel` for icon-only buttons (the label defaults to "Button"). Submit buttons and links styled as buttons use the global `.bb-btn` classes (`--outlined`, `--text`, `--soft`, `--accent`, `--danger`, `--small`, `--icon`), because `np-button` can't submit or link. Paginated lists use `<np-pagination variant="compact">` (right-aligned globally) with `pagedList(...).goTo(page, rows?)`.
  - **Icons:** NexPrime `<np-icon name="…" class="mat-icon" matButtonIcon />` only, no `mat-icon`. Names are NexPrime/Lucide file names (`chef-hat`). Material names still in data (category icons in the database, nav items) go through `| npIcon` (`shared/icons/np-icon-name.ts`). Size with `--bb-icon-size` (global default 24px, 18px in text buttons), not width/height.
  - Breakpoint mixins are in `breakpoints`: `tablet-up`, `desktop-up`, `phone-only` and `below-desktop`, at 600 and 1024 px.
- **PWA:** `ngsw-config.json` (production builds only). Only the public catalogue API is cached; never add private endpoints (auth, cart, orders, payments) to a data group. Keep Material/NexPrime out of the eagerly loaded graph (`app.ts`, `app.routes.ts` eager routes, root services): NexPrime does not tree-shake and adds ~270 kB. `app-status` is `@defer`red for this reason. Services: `connection-status`, `app-update`, `install-prompt`, `push-notification` (in `core/services`); UI in `shared/components/{app-status,install-banner,push-settings}`. Floating UI must not shift layout (CLS).
- **Maps:**
  - `shared/components/map-picker` is the pin picker.
  - `shared/components/tracking-map` is the read-only delivery map.
  - `tracking-map/delivery-tracking.ts#deliveryTracking(order)` provides rider position, staleness, the trail, routes and ETA, and is shared by the customer and admin views. It loads `GET /tracking/orders/{id}` (`core/services/order-tracking.service.ts`) when it starts and after every socket reconnect.
  - The rider's device GPS is shared through `core/services/rider-gps.service.ts`.

## Verification tips

- **Visual checks:** a headless check is the reliable way to confirm UI changes. Playwright-core with `/usr/bin/google-chrome` works here. Test logins against the real API can trip the 15-minute auth rate limit.
- **Throwaway API:** for flows that write data, run a separate API on another port against MongoMemoryServer. Point the browser at it with `context.route` (HTTP) and `context.routeWebSocket` (proxy `/socket.io`).
- **Stopping processes:** use a pattern that can't match the shell running the command, e.g. `ps … | awk '/[s]erver.mjs/'`. Plain `pkill -f` has killed its own shell here.
