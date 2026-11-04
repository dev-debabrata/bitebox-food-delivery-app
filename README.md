# BiteBox — Food Delivery Platform

BiteBox is a full-stack food delivery app with four role-based panels: **Customer**, **Admin**, **Restaurant**, and **Delivery partner**. It runs on web, tablet, and mobile.

| Part     | Stack |
|----------|-------|
| Frontend | Angular 22 (standalone components, Signals, SSR/prerender), Angular Material 22, NexPrime UI, Leaflet + OpenStreetMap, SCSS |
| Backend  | Node.js + Express 5 (JavaScript ES modules), Mongoose 9, JWT, bcrypt, express-validator, pino, Swagger UI |
| Database | MongoDB (local or Atlas) |

> **Status: Phase 7 complete — production ready.** All seven phases are done: authentication; restaurants and menus; cart and checkout; order management and delivery; maps and live tracking; payments, notifications and reports; and final quality and deployment (tests, security, performance, accessibility, Docker, CI, docs).

---

## 1. Prerequisites

- Node.js **24 LTS** (or 22.22+ / 26+, as required by Angular 22) and npm 10+
- MongoDB **7+**: a local `mongod`, Docker (`docker run -d -p 27017:27017 mongo:8`), or a free MongoDB Atlas cluster

## 2. Setup

```bash
# Backend
cd backend
npm install
cp .env.example .env        # then edit .env (see below)

# Frontend
cd ../frontend
npm install
```

### Backend `.env`

| Variable | Purpose |
|----------|---------|
| `MONGO_URI` | MongoDB connection string |
| `CLIENT_URL` | Allowed browser origin(s), comma-separated. The first one is used in password-reset emails. |
| `JWT_SECRET` | 32+ random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_EXPIRES_IN` | Access-token lifetime. Keep it short (default `15m`); the refresh cookie renews it. |
| `SMTP_*`, `EMAIL_FROM` | Sends password-reset emails. **If left empty in development, the reset link is printed to the backend console.** |
| `SEED_PASSWORD` | Development-only password for the seeded sample accounts |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | When all three are set, uploaded images are stored in **Cloudinary** (folder `CLOUDINARY_FOLDER`, default `bitebox`) and served with automatic format and quality. Recommended for production. |
| `UPLOAD_DIR`, `PUBLIC_BASE_URL` | Fallback without Cloudinary: images are saved on local disk (default `uploads/`, git-ignored) and the API origin used in their URLs |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Optional. When both are set, checkout offers real online payment through Razorpay (use test-mode keys in development). |
| `RAZORPAY_WEBHOOK_SECRET` | Optional. Secret of the Razorpay webhook pointed at `/api/v1/payments/webhooks/razorpay`. |
| `PAYMENTS_MOCK` | `true` (default outside production) offers the **simulated test payment** when Razorpay is not configured. It is never available in production. |
| `REPORT_TIMEZONE` | Time zone used to group reports and earnings by day (default `Asia/Kolkata`) |

`.env` is git-ignored. Never commit real credentials.

### Frontend environments

- `src/environments/environment.ts` (development, the default) calls the API directly on port 5000 of the host the page was opened from (`http://localhost:5000/api/v1`, or `http://<LAN IP>:5000/api/v1` from another device). Add that page origin to `CLIENT_URL` so CORS allows it.
- `src/environments/environment.prod.ts` (swapped in by the production build) sets `apiUrl: '/api/v1'`, which assumes a reverse proxy serves the API on the same origin.

These files are bundled into browser code, so **never put secrets in them**.

## 3. Seed development data (optional)

```bash
cd backend
SEED_PASSWORD='Choose-a-dev-pass1' npm run seed
# rerun safely any time; add `-- --reset-passwords` to reset the seed users' passwords
```

| Role | Email |
|------|-------|
| Admin | `admin@bitebox.test` |
| Customer | `customer@bitebox.test` |
| Restaurant | `restaurant@bitebox.test` |
| Delivery | `rider@bitebox.test` |

Every role signs in on the same page, **`/login`**, and lands in its own panel (`/admin`, `/restaurant`, `/delivery`, or the customer site). The old addresses `/admin/login`, `/restaurant/login` and `/delivery/login` redirect there. Sign-up stays separate: `/register` for customers, `/restaurant/register` for restaurants, `/delivery/register` for riders.

All four accounts use your `SEED_PASSWORD`. **They are for development only.** The script refuses to run when `NODE_ENV=production`.

The seed also creates:
- 8 food categories
- one **approved** restaurant, *Spice Route Kitchen*, in Indiranagar, Bengaluru, owned by the restaurant account
- 8 menu items for that restaurant

- coupons `WELCOME50` (50% off up to ₹100, minimum order ₹199, once per customer) and `FLAT75` (₹75 off on ₹399 or more)
- a default delivery address for the customer, about 4 km from the restaurant
- a vehicle (motorbike) for the rider, who starts offline

All seeded data is fictional. Rerunning the seed never creates duplicates.

## 4. Run (two terminals)

```bash
# Terminal 1: API on http://localhost:5000
cd backend && npm run dev

# Terminal 2: web app on http://localhost:4200
cd frontend && npm start
```

- API docs (Swagger UI): <http://localhost:5000/api/docs> (raw OpenAPI JSON: `/api/docs.json`)
- Health check: <http://localhost:5000/api/v1/health>

## 5. Test, lint, build

```bash
cd backend
npm test        # 171 tests: Node test runner + supertest against an in-memory MongoDB
npm run lint

cd ../frontend
npm test -- --watch=false   # 104 Vitest unit tests
npm run build               # production build (SSR + prerendered public pages) into dist/frontend
npm run serve:ssr:frontend  # serve the production build on :4000
```

- **Coverage:** backend ≈95% of lines (`NODE_ENV=test node --test --experimental-test-coverage --test-coverage-include='src/**' "tests/**/*.test.js"`).
- **What the backend tests cover:** auth and sessions, every role's permissions, catalogue, cart and checkout (with and without transactions), order workflow and dispatch timeouts, live tracking sockets, payments (simulated and Razorpay with a fake gateway, webhooks, refunds), notifications, earnings and reports, uploads, admin tools.
- **`tests/docs.test.js`** fails if any API route is missing from the OpenAPI docs (or the docs list a route that doesn't exist).
- **CI:** `.github/workflows/ci.yml` runs lint, both test suites and the production build on every push and pull request.

To run the backend tests against a real MongoDB instead of the in-memory one, set `TEST_MONGO_URI`. The database name **must end in `_test`**, because the tests wipe its collections:

```bash
TEST_MONGO_URI='mongodb://127.0.0.1:27017/bitebox_test' npm test
```

## 6. Production deployment

The production setup is one public origin: a reverse proxy sends `/api`, `/socket.io` and `/uploads` to the API, and everything else to the Angular SSR server.

```
browser ──► nginx (:8080)
              ├── /api/  /socket.io/  /uploads/ ──► api   (Node/Express, :5000) ──► MongoDB
              └── everything else                ──► web   (Angular SSR, :4000) ──► api (API_INTERNAL_URL)
```

### With Docker (recommended)

```bash
cp deploy/.env.example deploy/.env     # set JWT_SECRET, PUBLIC_URL, PUBLIC_HOST (+ optional keys)
docker compose --env-file deploy/.env up -d --build
# open http://localhost:8080
```

`docker-compose.yml` starts:
- **MongoDB 8** as a single-node replica set (so multi-document transactions are used)
- the **API** image (`backend/Dockerfile`: production dependencies only, non-root user)
- the **web** image (`frontend/Dockerfile`: multi-stage build, runs only the built output)
- **nginx** with `deploy/nginx.conf` (WebSocket upgrade for live updates, 3 MB upload limit)

Data lives in the `mongo-data` and `uploads` volumes. Each service has a health check (`/api/v1/health`, `/healthz`).

### Without Docker

1. **API:** `cd backend && npm ci --omit=dev && NODE_ENV=production node src/server.js`, with the variables below.
2. **Web:** `cd frontend && npm ci && npm run build`, then `node dist/frontend/server/server.mjs` (`PORT`, default 4000). The `dist/frontend` folder is self-contained.
3. **Proxy:** put both behind one domain with **HTTPS** (`deploy/nginx.conf` is a working starting point).

### Production settings

| Where | Variable | Notes |
|---|---|---|
| API | `NODE_ENV=production` | Turns off the test payment, debug error details and dev logging; cookies become `Secure`. |
| API | `MONGO_URI`, `JWT_SECRET` | Required. Atlas is a replica set already. |
| API | `CLIENT_URL`, `PUBLIC_BASE_URL` | Your public URL (CORS, emails, locally stored image URLs). |
| API | `TRUST_PROXY=1` | Behind a proxy, so rate limits see real client IPs. |
| API | `RAZORPAY_*`, `CLOUDINARY_*`, `SMTP_*` | Payments, image hosting and email (see section 2). |
| Web | `API_INTERNAL_URL` | How the SSR server reaches the API (e.g. `http://api:5000`); calls from the browser stay same-origin. |
| Web | `NG_ALLOWED_HOSTS` | Your domain (Angular's SSRF protection rejects other hosts). |

**Checklist:** HTTPS in front; a strong `JWT_SECRET`; Cloudinary (or a persistent `uploads` volume); Razorpay **live** keys and the webhook (`/api/v1/payments/webhooks/razorpay`); a production map tile provider and routing server (the public OpenStreetMap/OSRM servers are for light use only); MongoDB backups; never run the seed in production (it refuses to).

## Architecture

### Authentication

- **Access token:** a JWT (HS256, 15 min) returned in the JSON response and kept **only in memory** in the Angular `AuthService`. It is never written to localStorage.
- **Refresh token:** a random opaque token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production) scoped to `/api/v1/auth`. The database stores only its SHA-256 hash.
  - It **rotates** on every refresh. Replaying an already-rotated token revokes the whole session family (theft detection). A 15-second grace window absorbs two tabs refreshing at the same time.
  - On page load the app calls `/auth/refresh` to restore the session.
- **CSRF protection** on the cookie endpoints (`/refresh`, `/logout`): these require the `X-Requested-With: BiteBox` header (which forces a CORS preflight) and an allow-listed `Origin`.
- **Passwords:** hashed with bcrypt (12 rounds). Policy: 8–72 bytes, at least one letter and one number.
- **Password reset:** a single-use token valid for 30 minutes, stored hashed and consumed atomically. A reset also revokes all sessions and outstanding access tokens (`tokenVersion`). The forgot-password response is identical whether or not the email exists.
- **Roles:** `customer`, `admin`, `restaurant`, `delivery`. Admins cannot self-register.
  - Each panel has its own sign-in page, and the API rejects sign-ins from the wrong portal.
  - The backend enforces every permission (`authorize(...roles)`). The Angular route guards exist only for UX.
- **Other protections:** rate limits on auth endpoints, Helmet security headers, a CORS allow-list, 100 kB body limit, NoSQL-operator stripping, strict validation (unknown body fields are dropped), and redaction of secrets in logs.

> If the frontend and API are deployed on **different sites**, set `COOKIE_SAMESITE=none` (HTTPS required) and add the frontend origin to `CLIENT_URL`. Serving both under one domain behind a reverse proxy is the simpler setup.

### API response format

```json
{ "success": true,  "message": "Signed in successfully", "data": { } }
{ "success": false, "message": "Validation failed", "error": { "code": "VALIDATION_ERROR", "details": [{ "field": "email", "message": "..." }] } }
```

### Phase 1 endpoints (`/api/v1`)

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | none |
| POST | `/auth/register`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` | none (rate-limited) |
| POST | `/auth/refresh`, `/auth/logout` | refresh cookie + CSRF header |
| GET/PATCH | `/auth/me` | bearer |
| POST | `/auth/change-password` | bearer |
| GET | `/admin/users?role=&status=&search=&page=&limit=` | bearer, admin |

### Phase 2 endpoints (`/api/v1`)

All money values are **integer paise** (₹1 = 100), for example `pricePaise: 32900` is ₹329. The full contract is in Swagger at `/api/docs`.

| Area | Endpoints | Access |
|------|-----------|--------|
| Discovery | `GET /restaurants` (search, cuisine, category, veg, sort, `lat`/`lng`/`radiusKm`, paging), `GET /restaurants/cuisines`, `GET /restaurants/{slugOrId}`, `GET /restaurants/{slugOrId}/menu`, `GET /categories`, `GET /foods` (dish search), `GET /foods/{id}` | public, approved restaurants only |
| My restaurant | `GET/POST/PATCH /my/restaurant`, `PATCH /my/restaurant/accepting-orders`, `GET/POST /my/restaurant/foods`, `PATCH/DELETE /my/restaurant/foods/{id}`, `PATCH /my/restaurant/foods/{id}/availability` | restaurant partner (own data only) |
| Admin | `GET /admin/restaurants`, `GET /admin/restaurants/counts`, `GET /admin/restaurants/{id}`, `PATCH /admin/restaurants/{id}/status`, `GET/POST /admin/categories`, `PATCH/DELETE /admin/categories/{id}`, `GET /admin/foods`, `PATCH /admin/foods/{id}/availability`, `DELETE /admin/foods/{id}` | admin |
| Uploads | `POST /uploads/images` (multipart field `image`) | restaurant partner, admin |

**Restaurant approval workflow.**
- A partner creates their restaurant, which starts as `pending` and is invisible to customers.
- An admin moves it along the allowed transitions:
  - pending → approved or rejected
  - approved → suspended
  - suspended → approved
  - rejected → approved
- Rejecting or suspending requires a reason, which the owner sees.
- If the owner edits a rejected restaurant, it is re-submitted as `pending`.
- Status changes are conditional updates, so two admins acting at the same time cannot both succeed.

### Phase 3 endpoints (`/api/v1`, customers unless noted)

| Area | Endpoints |
|------|-----------|
| Cart | `GET /cart`, `DELETE /cart`, `POST /cart/items`, `PATCH /cart/items/{foodItemId}` (quantity 0 removes), `DELETE /cart/items/{foodItemId}`, `POST /cart/coupon`, `DELETE /cart/coupon`. Every response is the full **server-priced quote**; add `?addressId=` to quote delivery to a specific address. |
| Addresses | `GET/POST /addresses`, `PATCH/DELETE /addresses/{id}`, `PATCH /addresses/{id}/default` (max 10 per customer) |
| Orders | `POST /orders` (header `Idempotency-Key`), `GET /orders`, `GET /orders/{id}` |
| Coupons | `GET /coupons/available`; admin: `GET/POST /admin/coupons`, `PATCH/DELETE /admin/coupons/{id}` |

**How an order is priced.** The server recomputes everything; the browser never sends prices. The rules live in `backend/src/config/pricing.js`:

| Line | Rule |
|------|------|
| Item total | current menu price × quantity |
| Coupon | percentage (optionally capped) or a flat amount; never more than the item total |
| Delivery fee | ₹25 for the first 2 km, then ₹8 per extra km (rounded up), capped at ₹99. Free when the item total after the coupon is ₹499 or more. |
| Delivery range | straight-line distance up to 15 km |
| Platform fee | ₹5 |
| GST | 5% of the item total after the coupon |

The cart page shows anything that blocks checkout: unavailable dishes, a closed or paused restaurant, a total below the restaurant's minimum, no address, or an address out of range.

**How placing an order is protected.**
- **Price changes:** the client sends `expectedTotalPaise`, the total the customer saw. If the server's total differs, it returns `409 PRICE_CHANGED` and nothing is charged or created.
- **Retries:** the `Idempotency-Key` header makes a retried request (double click, flaky network) return the original order instead of creating a second one.
- **Double checkout:** the cart is claimed with a version-checked delete, so the same cart can never become two orders, even when submitted twice at once.
- **Coupon limits:** coupon use is reserved with an atomic conditional increment, which enforces the total usage limit. A redemption record enforces the per-customer limit.
- **All-or-nothing writes:** everything runs in a MongoDB transaction when the server supports it (Atlas, replica sets). On a single local `mongod`, each completed step is undone if a later step fails. Both paths are covered by tests.
- **Snapshots:** orders store copies of item names and prices, the delivery address, and the restaurant details, so later menu edits never change a past order.
- **Payment:** every order gets a `Payment` record. Cash on delivery is marked paid on delivery; online payment is described in Phase 6 below.

**Delivery location.**
- The header has a **location picker**: use your current GPS location, search for a place, or pick a saved address.
- The home page and restaurant list then show only restaurants within 15 km of that point (the list has "Show all restaurants" to override).
- The choice is remembered in this browser (localStorage).

**Place search** goes through `GET /api/v1/geo/search` and `/geo/reverse`. These call OpenStreetMap Nominatim from the backend, which caches results for 24 hours and allows at most one upstream request per second.
- Set `GEOCODER_USER_AGENT` with your contact email, as Nominatim's usage policy requires.
- For production traffic, point `GEOCODER_URL` at a self-hosted or commercial geocoder.

**Nearby search.** Nearby results use MongoDB `$geoNear` on a 2dsphere index. The `distanceMeters` value is **straight-line** distance, not road distance; road routing arrives in Phase 5.

**Image uploads.**
- Only JPEG, PNG and WebP up to 2 MB are accepted.
- The file type is detected from the file's bytes, not its name or the browser-supplied type.
- Files are stored under random names and served with `nosniff` and `Cross-Origin-Resource-Policy: cross-origin`.
- Storage is local disk. Hosts with ephemeral disks need a cloud storage provider (see `src/services/upload.service.js`).

### Phase 4 endpoints (`/api/v1`)

| Who | Endpoints |
|-----|-----------|
| Customer | `GET /orders/{id}` (now includes the rider once assigned), `POST /orders/{id}/cancel` |
| Restaurant | `GET /my/restaurant/orders?view=active\|history`, `GET /my/restaurant/orders/{id}`, `PATCH /my/restaurant/orders/{id}/status` |
| Rider | `GET /delivery/me`, `PUT /delivery/me/vehicle`, `PATCH /delivery/me/availability`, `PUT /delivery/me/location`, `POST /delivery/offers/{id}/accept`, `POST /delivery/offers/{id}/decline`, `PATCH /delivery/orders/{id}/status`, `GET /delivery/orders/history` |
| Admin | `GET /admin/orders`, `GET /admin/orders/{id}`, `POST /admin/orders/{id}/cancel`, `POST /admin/orders/{id}/unassign`, `GET /admin/delivery-partners`, `PATCH /admin/delivery-partners/{id}/status` |

**Order statuses.** The backend enforces one transition table (`backend/src/services/order-workflow.service.js`); any other move returns `409 INVALID_TRANSITION`.

| From | To | Who |
|------|----|-----|
| Pending | Confirmed / Rejected (reason required) | Restaurant (auto-rejected after 10 minutes without an answer) |
| Pending | Cancelled | Customer, admin |
| Confirmed | Preparing | Restaurant |
| Preparing | Ready for pickup | Restaurant (starts rider dispatch) |
| Ready for pickup | Assigned | Rider accepting an offer |
| Assigned | Picked up | Rider |
| Assigned | Ready for pickup | Admin ("unassign": the order goes to another rider) |
| Picked up | On the way | Rider |
| On the way | Delivered | Rider (cash on delivery is marked paid) |
| Confirmed, Preparing, Ready, Assigned | Cancelled | Admin (reason required) |

Nobody can cancel an order once it has been picked up. Rejected, cancelled and delivered orders are final.

**How a rider is chosen (dispatch).** When an order is ready for pickup, the backend offers it to **one** rider at a time:
1. **Eligible:** online, active account, not carrying or being offered another order, location reported in the last 15 minutes, within 10 km of the restaurant (straight line), and has not already declined this order.
2. **Order:** nearest first, in 500 m bands; within a band, whoever was assigned least recently.
3. **Offer:** the rider has 90 seconds to accept. Declining passes the order to the next rider straight away. Ignoring it does the same, and also sets that rider offline, since they are probably away.

A background sweep runs every 15 seconds. It expires offers, retries orders that are waiting for a rider (for example, when someone comes online), and auto-rejects unanswered orders. These timings live in `backend/src/config/dispatch.js`.

**Safety.**
- **Atomic status changes:** each change is a conditional update ("only if it is still in status X"). Two people acting at once (say, the restaurant accepting while the customer cancels) cannot both win. The loser gets `409 ORDER_CHANGED`.
- **Harmless repeats:** repeating a change the order has already made, such as a double click, returns it unchanged.
- **One order per rider:** a rider is offered at most one order and carries at most one. Both are guarded by compare-and-set updates on their profile.
- **Side effects:**
  - Rejecting or cancelling returns the coupon use and cancels the pending cash payment.
  - Delivering marks the payment paid and frees the rider.
  - Each of these side effects is idempotent.
- **Scoped access:** restaurants only see their own orders, riders only their own offers and deliveries, and customers only their own orders. Anything else returns 404.
- **Privacy:** restaurants see the customer's name and area, never their phone number or exact address. Riders get the full drop-off address and phone number only after accepting.

**Live updates (Socket.IO).** Order changes reach every screen involved within about a second, with no refresh:
- the restaurant board (new orders, with an alert and chime)
- the rider dashboard (offers appearing and being withdrawn)
- the customer's order page and order list
- the admin pages

How it works:
- **Connection:** the browser connects to `/socket.io` on the API with its access token.
- **Rooms:** the server checks the token and the account, then places the connection in rooms derived only from that identity: the user's own room, their restaurant, and `admins` for admins. There is no way for a client to join a room itself.
- **Expiry:** the connection is closed when the access token expires, and the client reconnects with a fresh token.
- **Events:** an `order:updated` event carries only the order id, number and status. Screens then reload through the normal REST API, so MongoDB stays the source of truth.
- **Fallback:** every screen also refreshes every 30–60 seconds (paused while the tab is hidden), so a dropped connection delays updates but never loses them.
- **Sound:** browsers only play the restaurant's new-order chime after the page has been clicked once.


**Try the whole flow locally** (four browser profiles, or normal plus private windows):
1. Rider (sign in at `/login`): go online. This needs a **precise location**. On a desktop without GPS, set one in Chrome DevTools → More tools → Sensors → Location (for example latitude `12.9729`, longitude `77.6412`, next to the seeded restaurant).
2. Customer: order from *Spice Route Kitchen*.
3. Restaurant (sign in at `/login`, then Orders): Accept → Start preparing → Ready for pickup.
4. Rider: accept the request, then Picked up → Start delivery → Delivered.
5. Customer: the order page shows each step and the rider's details. Admin: `/admin/orders` and `/admin/delivery-partners`.

### Phase 5: maps and live tracking

**What you see.**
- **Customer order page:** a **Live tracking** map with the restaurant, the drop-off and the rider moving in real time. It shows "Arriving in about N min · X km by road", and "last location update … ago" when the rider's position is older than 90 seconds.
- **Rider dashboard:** a map of the active delivery with the road route from the rider's own GPS position to the next stop (restaurant, then customer).
- **Admin order dialog:** the same live map for orders on the road.

**Routing** (`GET /api/v1/geo/route`, signed-in users only):
- **Provider:** road distance, estimated travel time and the path come from OSRM (`ROUTING_URL`, `ROUTING_PROFILE`), behind a provider interface in `backend/src/services/routing.service.js`, so another provider can be plugged in.
- **Load:** results are cached for 10 minutes, and upstream calls are serialised at about 1 per second.
- **Production:** the default public OSRM demo server is for light testing only; use a self-hosted OSRM or a commercial router in production.
- **Fallbacks:** when routing is unavailable the API returns `503 ROUTING_UNAVAILABLE`, and maps draw a dashed straight line instead. If the map itself cannot load, the page still shows status and estimates as text.

**Distances are labelled honestly:**
- **Straight-line distance:** used for delivery fees and dispatch.
- **Road distance and time:** an *estimate* from the routing provider, without live traffic.
- **Actual progress:** the rider's live GPS position, with its age.

**Live location (Socket.IO).**
- **Sharing:** the rider's device shares GPS while they are online:
  - about every 4 seconds while moving during a delivery, and at least every 15 seconds
  - about once a minute when idle, which keeps dispatch distances fresh
- **Server checks** on every `rider:location`:
  - it must come from a rider's own authenticated connection
  - coordinates must be valid
  - accuracy must be within 1 km
  - no jumps faster than about 250 km/h
  - at most about one update per second, in short bursts of five
- **Who sees it:** positions are saved for dispatch, and broadcast only to the room of the order the rider is carrying, and only while it is assigned, picked up or on the way.
- **Watching:** customers, the order's restaurant, its rider and admins watch with `track:join { orderId }`. The server checks permission against the database before joining the room, and replies with the last known position and its time.
- **When an order finishes:** everyone is removed from its room, so the rider's location is no longer shared.
- **Reconnects:** the app rejoins automatically after a reconnect.

**Problems the app explains instead of failing silently:**
- location permission denied
- no GPS
- an imprecise (desktop/IP) location
- a dropped connection
- a stale rider position

**Testing GPS on a desktop:** Chrome DevTools → More tools → **Sensors** → Location. To watch the customer's map move, change the rider's location in small steps (for example 0.0007° of latitude, about 75 m, every few seconds). Large jumps are rejected as impossible.

### Phase 6: payments, notifications and reports

**Payment methods** (`GET /api/v1/payments/methods` lists what checkout offers):
- **Cash on delivery:** always available. The restaurant receives the order at once; it is marked paid when delivered.
- **Razorpay:** offered when `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set.
- **Test payment (simulated):** offered in development when Razorpay is not configured. It is clearly labelled, moves no money, and lets you choose success or failure. It is disabled in production.

**Online payment flow.**
1. `POST /orders` with `paymentMethod: "online"` creates the order in *awaiting payment* and returns `checkout` (the gateway order id, amount and public key id).
2. The browser opens the gateway. For Razorpay it then calls `POST /payments/orders/:id/confirm`. The server verifies the HMAC signature, then fetches the payment from Razorpay and checks its status, order id and amount before marking it paid.
3. The webhook (`POST /payments/webhooks/razorpay`, verified by `X-Razorpay-Signature` over the raw body) is the backstop when the browser closes early. Each event id is applied once.
4. Only once paid does the restaurant see the order and get notified. Its response timer starts then.
- **Closing or failing the payment page** at checkout cancels the attempt at once (`POST /payments/orders/:id/abandon`), puts the dishes back in the cart and keeps the customer on checkout. Nothing is ordered, and the attempt is not listed in "My orders".
- **Retry:** if the browser closed mid-payment, the order page offers "Pay ₹…" (`POST /payments/orders/:id/start`).
- **Pickup deadline:** an order that no rider has picked up within 30 minutes of being ready (no rider found, or the assigned rider never arrived) is cancelled automatically, refunded if paid online, and the rider is freed (`pickupWindowMinutes`). The restaurant's order card shows the deadline.
- **Expiry (backstop):** unpaid online orders that were never abandoned are cancelled after 15 minutes (`paymentWindowMinutes` in `config/dispatch.js`).
- **Refunds:** cancelling or rejecting a paid online order refunds it through the gateway. A payment that arrives after the order expired is refunded too. If a refund fails, the admin **Payments** page flags it with **Retry refund** (`POST /admin/payments/:id/refund`).

**Notifications** (`/api/v1/notifications`, every role):
- Stored per user, kept for 90 days, and pushed live over Socket.IO (`notification:new`).
- The bell in every header shows the unread count. Opening an item marks it read and follows its link; **Mark all read** clears the count.
- **See all notifications** (bottom of the bell) opens the full Notifications page of each module (`/notifications`, `/restaurant/notifications`, `/delivery/notifications`, `/admin/notifications`): full text, All / Unread (`GET /notifications?unread=true`), paging, live updates.
- **Customers:** order placed, accepted or rejected, rider assigned, picked up, delivered, cancelled, refund processed.
- **Restaurants:** new orders (cash or paid online), rider assigned, picked up, delivered, cancelled; their restaurant approved, rejected or suspended.
- **Riders:** new delivery requests, an order they carry cancelled or reassigned.
- **Admins:** every new order, rejection, cancellation and delivery; refunds and failed refunds; new restaurant applications and resubmissions; new restaurant and delivery partner sign-ups.
- Defined in `services/order-notifications.js` (orders and payments), `restaurant.service.js` and `auth.service.js`.

**Earnings and settlement.**
- When an order is delivered, its split is fixed in `order.settlement` (`config/earnings.js`):
  - restaurant: food value after discounts, minus a 15% commission
  - rider: ₹20 per delivery plus ₹6 per started kilometre (straight-line)
  - platform: the rest of the order total
- **Restaurant panel → Earnings** (`GET /my/restaurant/earnings?days=`) and **Delivery panel → Earnings** (`GET /delivery/earnings?days=`) show totals, a daily chart and recent orders for 7, 30 or 90 days.

**Admin reports** (`GET /admin/reports?days=`):
- **Reports page:** delivered value (GMV), platform revenue, delivered and cancelled orders, average order, refunds and new customers; daily charts of value and of orders placed vs delivered; payment mix; order outcomes; top restaurants.
- **Dashboard:** shows the last 30 days at a glance.
- **Scope:** figures cover orders *placed* in the period; values count delivered orders only. Every chart has a "Show as table" view.

### Ratings and reviews

**Review policy** (`backend/config/reviews.js`):
- **What can be reviewed:** a customer can review the restaurant, each dish and the rider of their own **delivered** order. Each one can be reviewed once. A rating is 1 to 5 whole stars, with an optional comment of up to 1000 characters.
- **Photos:** restaurant and dish reviews can have up to 5 photos (JPEG, PNG or WebP, 2 MB each). Customers upload them with `POST /uploads/review-images`, and reviews accept only URLs that BiteBox stored (local uploads or our Cloudinary account), never outside links. Delivery ratings take no photos.
- **Server checks:** eligibility is checked on the server against the order in the database (owner, `delivered` status, which dishes were in it, who delivered it). A unique index on `(order, target, foodItem)` stops duplicates, including double-clicks.
- **Time limits:** reviews can be written for 30 days after delivery. A review can be edited for 30 days after it is posted, and earlier versions are kept for moderators. Deleting is final: the review leaves every page and average, and it can't be written again for that order.
- **What others see:** a short name ("Asha C.") and a "Verified order" badge. Restaurants also see the order number. Riders see only the customer's first name and the order number. Nobody sees phone numbers or addresses.
- **Moderation:** admins can **hide** (pending a decision), **remove** (breaks the policy) or **restore** a review. A reason is always required; the author sees it, and it is appended to the review's moderation log. Admins never edit a review's words.

**Ratings.**
- **Where they are stored:** each restaurant, dish and rider has a cached `rating { average, count, distribution[5] }`, built from **published** reviews only.
- **How they are updated:** every create, edit, delete and moderation action rebuilds the summary from the reviews themselves (`review.service.js#refreshRating`) instead of adding deltas, so counts cannot drift.
- **Where they are shown:** restaurant cards, restaurant pages, dish details, the rider card on an order, and the panels.

| Who | Endpoints (`/api/v1`) |
|---|---|
| Public | `GET /restaurants/{slugOrId}/reviews`, `GET /foods/{id}/reviews` (`rating`, `sort=newest\|oldest\|highest\|lowest`, paging; include the summary) |
| Customer | `GET /orders/{id}/reviews` (what can be rated on that order), `POST /orders/{id}/reviews` (restaurant, food quality and delivery in one go, see below), `POST /reviews`, `GET /reviews/mine`, `GET/PATCH/DELETE /reviews/{id}`, `POST /uploads/review-images` |
| Report | `POST /reviews/{id}/reports`: customers (any review but their own), the reviewed restaurant, the reviewed rider |
| Restaurant | `GET /my/restaurant/reviews/orders` (one row per order; `target`, `foodItemId`, `rating`, `responded`, `sort`), `GET /my/restaurant/reviews/orders/{orderId}`, `GET /my/restaurant/reviews` (flat list), `GET /my/restaurant/reviews/summary`, `PUT/DELETE /my/restaurant/reviews/{id}/response` |
| Rider | `GET /delivery/reviews` (read-only, with their summary) |
| Admin | `GET /admin/reviews/orders` (one row per order, `reported=true` puts reported orders first), `GET /admin/reviews/orders/{orderId}`, `GET /admin/reviews` (flat list), `GET /admin/reviews/{id}` (earlier versions, reports, log), `POST /admin/reviews/{id}/moderation` (`hide\|remove\|restore` + reason), `POST /admin/reviews/{id}/reports/dismiss`, `GET /admin/reviews/analytics?days=` |

**Screens.**
- **Customers:** a delivered order shows "How was your order?". Its button opens the **Rate your experience** dialog. "Rate this order" in My orders opens the dialog directly (`/orders/{id}?rate=1`).
  - **The dialog:** Restaurant, Food quality and Delivery partner star rows (with "n/5"), "Write a review" and photos, then **Submit rating**.
  - **Saving:** everything is saved with one `POST /orders/{id}/reviews`, all or nothing. The comment and photos belong to the restaurant review, so the restaurant must be rated to add them. The food-quality rating is given to every dish not yet rated.
  - **Your ratings:** once something is rated, the order page shows one summary card (a chip per rating, the review and photos) with a single button: **Rate the rest**, **View & edit** or **View**. It opens the same dialog, pre-filled: one row per dish once any dish has its own rating, edit or delete each rating, change the words and photos. Moderated ratings, or ones past the edit window, show read-only with the reason.
- **More for customers:** The restaurant page lists reviews and their photos, with a star filter and sort. Dish details show that dish's reviews. Customers can report any review.
- **Restaurant → Reviews:** the rating summary and dish ratings, filters, and one row per order (author, a chip per rating, the review, photos, "needs a reply"). Clicking a row opens that order's restaurant and dish reviews, where the restaurant replies publicly (edit or remove; the review itself can't be changed) and reports.
- **Delivery → Ratings:** the rider's summary and ratings; riders can report but not change them. The dashboard shows the rider's rating.
- **Admin → Reviews:** a **Reported** queue and **All reviews**, one row per order. Clicking a row opens all of that order's reviews (restaurant, dishes, delivery) with their open reports and the hide / remove / restore / dismiss actions. **History** shows a review's earlier versions, every report and its moderation log. **Analytics**: averages per target, daily volume and average, report reasons, moderation counts, and the best- and worst-rated restaurants and riders (at least 3 reviews).
- **Notifications:** restaurants and riders hear about new reviews. Customers hear about replies and moderation. Admins hear about the first report on a review.

### Quality: security, performance and accessibility

**Security**
- Every route is checked for its role (`authenticate` + `authorize`); partner and rider endpoints take their scope from the signed-in user, never from ids sent by the client. Customers can only reach their own orders, addresses, payments and notifications.
- Input is validated and stripped of unknown fields (express-validator), MongoDB operators are removed from input (`mongoSanitize`), and uploads are checked by their real bytes (JPEG/PNG/WebP, 2 MB).
- Short-lived JWTs in memory; rotating refresh token in an HttpOnly, SameSite=Strict cookie (Secure in production); password changes and suspensions apply at once.
- Rate limits on sign-in, coupons, uploads and geo lookups; Helmet headers on the API; `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy` on the web server.
- Payments: Razorpay signatures and amounts are verified server-side; webhooks are HMAC-checked and applied once; the test payment can't run in production.
- `npm audit`: no backend vulnerabilities; the frontend's only report is a low-severity `quill` issue in a NexPrime editor BiteBox doesn't use.

**Performance**
- gzip/brotli on the API and web server; fingerprinted assets cached for a year, the HTML shell never cached.
- Lazy-loaded feature routes; first load ≈118 KB transferred; the home page is server-rendered with its data, and hydration reuses it (no second request).
- Indexes for every list and report query; reports use single aggregation passes; external geo services are cached, de-duplicated and throttled.
- Images from Cloudinary use automatic format and quality (`f_auto,q_auto`).

**Accessibility** (checked with axe-core on 14 key pages across all four panels, WCAG 2.1 AA)
- Colour contrast meets AA (the brand green was darkened slightly for this).
- One `h1` per page and a logical heading order; buttons and links are named by their visible text.
- "Skip to content" links in the customer site and the panels; focus-visible styles; live regions for order status; the map is a labelled region and its information is also given as text.
- The only remaining finding is a minor empty table header inside NexPrime's chart component.

### Folder layout

```
backend/src
  app.js            Express app factory (middleware, routes, error handling)
  server.js         HTTP server + Socket.IO, DB connection, dispatch sweep, graceful shutdown
  config/           env validation, logger, MongoDB, Cloudinary, pricing/dispatch/earnings rules
  routes/ validators/ controllers/   HTTP layer (validate → controller → service)
  services/         business logic: auth, catalogue, cart, orders (workflow, dispatch), payments/, notifications, reports
  models/           Mongoose models
  sockets/          realtime: auth handshake, rooms, rider tracking
  docs/             OpenAPI fragments (Swagger UI at /api/docs)
  middleware/ utils/ scripts/ (seed)
backend/tests       API integration tests (one file per area, plus docs.test.js)
backend/Dockerfile  production API image

frontend/src/app
  core/             auth, guards, interceptors, API and realtime services
  shared/           models, form rules, icons, reusable components (maps, charts, phone input, bell…)
  layout/           auth, customer and panel shell (admin/restaurant/delivery) layouts
  features/         customer, checkout, orders, admin, restaurant-panel, delivery-panel, notifications, earnings, auth, profile, errors
frontend/src/server.ts   SSR server (security headers, compression, /healthz)
frontend/Dockerfile production web image

deploy/             nginx reverse proxy config and docker-compose settings template
docker-compose.yml  full production-like stack
.github/workflows/  CI (lint, tests, build)
docs/               troubleshooting guide
```

### UI libraries

- **Angular Material** provides form fields, dialogs, menus, tables and other core controls.
- **NexPrime** (`nexprime`) is used where it adds something Material lacks:
  - `np-timeline`: the order progress tracker
  - `np-confetti`: the "Order placed!" celebration
  - `np-scroll-top`: the back-to-top button on customer pages
  - `np-animate-on-scroll`: home page sections

  Its theme (`node_modules/nexprime/styles/theme.css`) loads before `src/styles.scss`, which maps NexPrime's `--ui-*` colour and font variables to the BiteBox brand. Its icons are served from `/icons`.
- **NexPrime 0.1.5 declares Angular 21** as an optional peer dependency. The library is compiled for Angular 17+ and builds and runs with Angular 22. `package.json` contains an npm `overrides` entry that points only NexPrime's Angular peers at the project's own Angular version. This avoids disabling peer-dependency checks for every package with `--legacy-peer-deps`. Remove the override once NexPrime publishes Angular 22 support.

### Responsive design

The layouts are built mobile-first, with breakpoints at **600px** (tablet) and **1024px** (desktop):
- **Partner panels:** the sidebar is persistent on desktop and becomes a slide-over drawer on tablets and phones.
- **Customer site:** phones get a bottom tab bar.
- **Admin users list:** a table on wide screens and stacked cards on narrow ones.
- **Restaurant grids:** 1, 2, 3 or 4 columns depending on screen width.
- **Restaurant menu:** category jump-links scroll horizontally on phones and become a sticky sidebar on desktop.

---

## Troubleshooting

See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** for symptoms, causes and fixes, grouped by setup, frontend development, tests, orders and maps, payments and images, and production deployment.

The three most common:
- **`ng serve` stuck on "Building..."**: use `npm start` (it sets `NG_BUILD_SASS_EMBEDDED=0`).
- **Signed out after every reload**: use `http://localhost:4200` (not `127.0.0.1`), and HTTPS in production.
- **Backend tests can't start MongoDB**: run with `TEST_MONGO_URI` pointing at a `*_test` database.
