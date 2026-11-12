# BiteBox: Food Delivery Platform

BiteBox is a full-stack food delivery app with four role-based panels: **Customer**, **Restaurant**, **Delivery partner** and **Admin**. It runs on web, tablet and mobile, and can be installed as a Progressive Web App.

| Part | Stack |
|---|---|
| Frontend | Angular 22 (standalone, signals, zoneless, SSR/prerender, Signal Forms), Angular Material, NexPrime, Leaflet + OpenStreetMap, service worker |
| Backend | Node.js + Express 5 (ES modules), Mongoose 9, Socket.IO, JWT, express-validator, pino, Swagger UI, Web Push |
| Database | MongoDB 7+ (local, Docker or Atlas) |
| Integrations | Razorpay, Cloudinary, SMTP, Nominatim (place search), OSRM (road routing) |

> **Status: production ready.** All seven phases are complete: authentication; restaurants and menus; cart and checkout; orders and delivery; maps and live tracking; payments, notifications and reports; and quality and deployment. Admin staff roles, reviews, coins and referrals, support tickets, and PWA install, offline mode and push notifications were added on top.

## Documentation

| Document | What's in it |
|---|---|
| **[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)** | **The complete reference:** architecture, configuration, roles and permissions, data model, business rules, realtime events, push and PWA, every API endpoint, every screen, security, testing, deployment |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes and fixes |
| [docs/COINS_REWARDS_PLAN.md](docs/COINS_REWARDS_PLAN.md) | Design notes for coins, referrals and campaigns |
| Swagger UI, `http://localhost:5000/api/docs` | The live API contract (raw JSON at `/api/docs.json`) |

## Features

- **Customers:**
  - Find restaurants within 15 km of a delivery point, search dishes, and order with cash or online payment.
  - Track the rider live on a map.
  - Rate the restaurant, the dishes and the delivery.
  - Earn and spend coins, refer friends, and get help through support tickets.
- **Restaurants:** onboarding with admin approval, menu management, a live order board with a new-order chime, review replies and earnings.
- **Riders:** go online, get offers one at a time from nearest-first dispatch, share live GPS, use route maps, and see earnings and ratings.
- **Admins:**
  - **Super admin:** staff admin management, users, catalogue, coupons, rewards, push promotions and the audit log.
  - **Operations:** orders, restaurants, riders and live monitoring.
  - **Finance:** transactions, refunds, payouts, commission and reports.
  - **Support:** tickets and review moderation.
- **Everywhere:**
  - Live updates over Socket.IO, an in-app notification inbox, and opt-in browser push notifications.
  - Installable PWA that works offline for pages already seen.
  - Responsive layouts and accessibility to WCAG 2.1 AA.

## Quick start

**Prerequisites:** Node.js 24 LTS (or 22.22+ / 26+), npm 10+, MongoDB 7+. For a local MongoDB you can run `docker run -d -p 27017:27017 mongo:8`.

```bash
# 1. Install
cd backend  && npm install && cp .env.example .env    # set MONGO_URI and JWT_SECRET (32+ chars)
cd ../frontend && npm install

# 2. Seed development data (optional, safe to rerun, refuses to run in production)
cd ../backend && SEED_PASSWORD='Choose-a-dev-pass1' npm run seed

# 3. Run (two terminals)
cd backend  && npm run dev    # API  http://localhost:5000  (Swagger /api/docs, health /api/v1/health)
cd frontend && npm start      # web  http://localhost:4200
```

Generate a JWT secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Every other variable is optional; see [Configuration reference](docs/DOCUMENTATION.md#5-configuration-reference).

- **Without SMTP:** password-reset links are printed in the API console.
- **Without Razorpay:** checkout offers a clearly labelled simulated payment (development only).
- **Without Cloudinary:** images are stored on local disk.
- **Without VAPID keys:** push notifications are off.

**Seeded accounts** (all use your `SEED_PASSWORD`; development only):

| Role | Email |
|---|---|
| Super admin | `admin@bitebox.test` |
| Operations / Finance / Support admin | `operations@bitebox.test`, `finance@bitebox.test`, `support@bitebox.test` |
| Customer | `customer@bitebox.test` |
| Restaurant | `restaurant@bitebox.test` (owns *Spice Route Kitchen*) |
| Rider | `rider@bitebox.test` |

The seed also creates the following fictional data:
- Food categories and 8 dishes.
- The coupons `WELCOME50` and `FLAT75`.
- A customer address.
- A rider vehicle.

**Signing in and up:**
- Every role signs in at **`/login`** and lands in its own panel (`/admin`, `/restaurant`, `/delivery`, or the customer site).
- Sign-up pages: `/register` (customers), `/restaurant/register` and `/delivery/register`.

To try a full order across all four roles, follow [Try the whole order flow](docs/DOCUMENTATION.md#try-the-whole-order-flow).

## Commands

```bash
# Backend (cd backend)
npm run dev                  # API with nodemon
npm test                     # integration tests (node:test + supertest, in-memory MongoDB)
npm run lint                 # eslint
TEST_MONGO_URI='mongodb://127.0.0.1:27017/bitebox_test' npm test   # real DB; name MUST end in _test

# Frontend (cd frontend). Always use the npm scripts: they set NG_BUILD_SASS_EMBEDDED=0.
npm start                    # dev server
npm test -- --watch=false    # unit tests (Vitest)
npm run build                # production build (SSR + prerender + service worker) into dist/frontend
npm run serve:ssr:frontend   # serve the production build on :4000 (needed to test the PWA)
```

CI (`.github/workflows/ci.yml`) runs lint, both test suites and the production build on every push to `master` and every pull request. `tests/docs.test.js` fails if an API route is missing from the OpenAPI docs.

## Deployment

The production setup is one HTTPS origin. nginx sends `/api`, `/socket.io` and `/uploads` to the API, and everything else to the Angular SSR server.

```bash
cp deploy/.env.example deploy/.env      # JWT_SECRET, PUBLIC_URL, PUBLIC_HOST (+ optional keys)
docker compose --env-file deploy/.env up -d --build
# open http://localhost:8080
```

This starts four services:
- MongoDB 8 as a replica set, so transactions are used.
- The API.
- The SSR web server.
- nginx.

Deployment without Docker, static hosting on Vercel or Netlify, and the full production checklist are in [Deployment](docs/DOCUMENTATION.md#19-deployment).

## Project layout

```
backend/            Express API: server.js, app.js, config/, routes/, validators/, controllers/,
                    services/, models/, sockets/, middleware/, utils/, docs/ (OpenAPI), scripts/seed.js, tests/
frontend/           Angular app: src/app/{core,shared,layout,features}, src/server.ts (SSR), public/, ngsw-config.json
deploy/             nginx.conf and the docker-compose .env template
docker-compose.yml  production-like stack
docs/               documentation, troubleshooting, rewards design
```

## Most common problems

- **`ng serve` stuck on "Building..."**: use `npm start`, which sets `NG_BUILD_SASS_EMBEDDED=0`.
- **Signed out after every reload**:
  - Use `http://localhost:4200`, not `127.0.0.1`.
  - In production, use HTTPS and set `CLIENT_URL` to the exact frontend URL.
- **Backend tests can't start MongoDB**: run them with `TEST_MONGO_URI` pointing at a `*_test` database.
- **No "Install" option or service worker**: the PWA works only in production builds, served over HTTPS or on `localhost`.

More fixes are in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
