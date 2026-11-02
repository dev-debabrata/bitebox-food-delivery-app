# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

BiteBox is a food delivery platform: an Angular 22 frontend (`frontend/`) and a Node/Express 5 + MongoDB backend (`backend/`, JavaScript ES modules). It has four role-based panels: customer, admin, restaurant and delivery. The README is the detailed reference for setup, endpoints and business rules.

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

## Backend architecture (`backend/src`)

- **Layering:** routes → `validate(...)` (express-validator) → controllers → services → Mongoose models.
  - `validate` puts the sanitised body in `req.body` and the query in `req.validatedQuery`, built from `matchedData`, so unknown fields are dropped.
  - Every response uses the envelope `{ success, message, data }` (`utils/api-response.js`).
  - Throw `ApiError` (`utils/api-error.js`) for client-visible errors. Anything else becomes a generic 500.
- **Auth:**
  - Short-lived JWT access tokens are kept only in browser memory.
  - A rotating refresh token lives in an HttpOnly cookie scoped to `/api/v1/auth`.
  - `authenticate` re-loads the user on every request and checks `status` and `tokenVersion`, so suspensions and password changes apply immediately. `authorize(...roles)` restricts by role.
  - Partner and rider endpoints (`/my/restaurant`, `/delivery`) resolve their scope from `req.user` and never trust ids from the client.
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
- **What each role sees:** `services/order-management.service.js` defines `presentForRestaurant` (no customer phone or exact address), `presentForRider` (full address only once carrying the order) and `presentWithRider` (customer and admin).
- **Realtime (Socket.IO):** `sockets/`, attached to the HTTP server in `server.js`.
  - **Handshake:** the client sends `auth.token` (the access token).
  - **Rooms:** they come only from the server-side identity (`user:<id>`, `restaurant:<id>`, `admins`) plus `order:<id>`. Tracking rooms are joined via `track:join` after a database permission check (`sockets/tracking.js`).
  - **Order events:** `emitOrderUpdated()` in `sockets/events.js` is called from the workflow, dispatch and order placement. Events carry ids and statuses only; clients re-read over REST.
  - **Rider positions:** `rider:location` is validated, rate-limited and checked for implausible speed, then broadcast to the active order's room.
  - **Tests:** when no server is attached, emits are no-ops.
- **External geo services:**
  - `services/geocoding.service.js` (Nominatim) and `services/routing.service.js` (OSRM, swappable via `useProvider`) both cache, serialise about 1 request per second, and fail with a 503 that the UI degrades on.
  - Distances are labelled as straight-line (fees and dispatch), road estimate (routing) or live GPS. Keep those distinctions.
- **API docs:** OpenAPI fragments in `docs/openapi.*.js`, merged in `docs/openapi.js`. Update them when routes change.

## Frontend architecture (`frontend/src/app`)

- **App shape:**
  - Standalone components, signals, `OnPush`, zoneless.
  - Lazy feature routes: `features/*/…routes.ts`, wired in `app.routes.ts`.
  - Panels use `layout/panel-shell`, with `NavItem.badge` for counts.
- **SSR:**
  - `app.routes.server.ts` sets the render modes. Home renders per request, the auth pages are prerendered, everything else is client-only.
  - Never touch `window`, `navigator` or `localStorage` outside `isPlatformBrowser` / `afterNextRender`.
  - Leaflet is imported dynamically inside `afterNextRender`.
- **Auth:**
  - `core/auth/auth.service.ts` restores the session at startup and exposes `user`, `initialised` and `displayUser`, a display-only localStorage hint that avoids a reload flicker and must never be used for access decisions.
  - `core/interceptors/auth.interceptor.ts` adds the token, sends cookies only to `/auth/*`, and refreshes on 401.
  - Pass `context: publicRequest()` on public catalogue calls so the SSR HTTP transfer cache can reuse them.
- **Live data:**
  - `core/services/realtime.service.ts` owns the socket: it connects while signed in, refreshes the token on handshake failure, and exposes `orderUpdates$`, `track(orderId)` and `sendRiderLocation()`.
  - Screens react to events, with a slow fallback poll from `core/services/poll.ts#pollWhileVisible` that pauses on hidden tabs. A request passed to it must catch its own errors.
  - `core/services/restaurant-order-board.ts` is a shared ref-counted store for the restaurant panel.
- **Forms:**
  - Use `form(model, schema, { submission: { action } })` with `<form [formRoot]>` and `[formField]`.
  - Reusable rules are in `shared/forms/form-rules.ts`. `shownError()` shows an error once the field is touched, and `serverErrors()` maps the API's 422 `{ field: 'a.b' }` errors onto fields.
  - Import `NP_FORM_FIELDS` (`shared/forms/np-form-fields.ts`), which bundles `FormField`, the NexPrime inputs, a touched-on-blur directive (NexPrime has no `touch` output), `NpInputAttrs` (forwards `autocomplete` and `inputmode`) and `<bb-field-error>`.
  - `np-text-input` takes `[error]`. Other NexPrime controls go in a `.bb-field` wrapper with `<bb-field-error>`.
- **UI:**
  - Angular Material (M3) plus NexPrime (`nexprime` package; npm `overrides` pin its Angular peers).
  - Brand tokens (`--bb-*`, NexPrime `--ui-*` mapped onto them) and global form and field rules live in `src/styles.scss`. NexPrime host widths are overridden there with `!important`, because their emulated host styles outrank element selectors.
  - Breakpoint mixins are in `breakpoints`: `tablet-up`, `desktop-up`, `phone-only` and `below-desktop`, at 600 and 1024 px.
- **Maps:**
  - `shared/components/map-picker` is the pin picker.
  - `shared/components/tracking-map` is the read-only delivery map.
  - `tracking-map/delivery-tracking.ts#deliveryTracking(order)` provides rider position, staleness, routes and ETA, and is shared by the customer and admin views.
  - The rider's device GPS is shared through `core/services/rider-gps.service.ts`.

## Verification tips

- **Visual checks:** a headless check is the reliable way to confirm UI changes. Playwright-core with `/usr/bin/google-chrome` works here. Test logins against the real API can trip the 15-minute auth rate limit.
- **Throwaway API:** for flows that write data, run a separate API on another port against MongoMemoryServer. Point the browser at it with `context.route` (HTTP) and `context.routeWebSocket` (proxy `/socket.io`).
- **Stopping processes:** use a pattern that can't match the shell running the command, e.g. `ps … | awk '/[s]erver.mjs/'`. Plain `pkill -f` has killed its own shell here.
