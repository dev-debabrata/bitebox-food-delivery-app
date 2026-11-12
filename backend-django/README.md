# BiteBox API (Django)

The Django + DRF + Channels + Celery backend that replaces the Node API in `../backend`, phase by phase. The plan, decisions and data model are in [`docs/django-migration/`](../docs/django-migration/README.md). Until the switch-over, the Node API remains the one the web app uses.

**Status: Phase 12 (payments).** Phases follow the user's 19-phase list from Phase 8 on (see the migration README).
- **Built:** the skeleton (settings, envelope and errors, pagination, permissions, health, OpenAPI, Celery, Docker, CI), the parity schema (45 tables, see [03 §3.5](../docs/django-migration/03-data-model.md#35-phase-4-implementation-notes-what-changed-from-the-plan-above)), sign-in and admin accounts, the catalogue and cart, and orders: placing them, the status workflow, dispatch to riders, the sweep (Celery Beat) and live updates over `/ws/`.
- **Not yet:** online payments (Phase 8; cash on delivery works), coins, reviews, notifications inbox and push.

## Quick start (without Docker)

Requires Python 3.12+.

```bash
cd backend-django
python3 -m venv .venv && .venv/bin/pip install -r requirements/dev.txt
cp .env.example .env

.venv/bin/pytest                    # tests (in-memory SQLite unless TEST_DATABASE_URL is set)
.venv/bin/ruff format . && .venv/bin/ruff check . && .venv/bin/mypy .

# Run the API on :8000 (a PostgreSQL and Redis are expected; see below)
.venv/bin/uvicorn config.asgi:application --reload --port 8000
```

Without PostgreSQL or Redis, the API still starts:
- `/api/v1/health` reports what is missing and returns 503.
- For local WebSocket work without Redis, set `CHANNEL_LAYER_IN_MEMORY=true` (single process, development only).
- `DATABASE_URL=sqlite:///dev.sqlite3` works for the skeleton. From Phase 4 (PostGIS models), a real PostgreSQL with PostGIS is required.

## Local PostgreSQL (Ubuntu 24.04, without Docker)

```bash
sudo apt install -y postgresql postgresql-16-postgis-3
sudo -u postgres psql <<'SQL'
CREATE ROLE bitebox LOGIN CREATEDB PASSWORD 'choose-a-password';
CREATE DATABASE bitebox OWNER bitebox;
SQL
# PostGIS needs a superuser once; template1 makes every new (test) database inherit it
for db in template1 bitebox; do
  sudo -u postgres psql -d "$db" -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
done
```

Then set both URLs in `.env`. Use a password of letters and digits, or URL-encode it.

```
DATABASE_URL=postgres://bitebox:choose-a-password@localhost:5432/bitebox
TEST_DATABASE_URL=postgres://bitebox:choose-a-password@localhost:5432/bitebox_test
```

- **Test database:** pytest creates `bitebox_test` at the start of each run and drops it at the end, which is why the role needs `CREATEDB`. To keep it between runs (faster), use `pytest --reuse-db`, and add `--create-db` after changing migrations.
- **PostgreSQL-only tests:** `tests/test_postgres.py` covers PostGIS, the indexes and the ledger trigger. It runs only against PostgreSQL.

## Quick start (Docker)

```bash
cd backend-django && cp .env.example .env
docker compose up --build           # db (PostGIS), redis, api (:8000, reload), worker, beat
docker compose run --rm api migrate
```

## Development data

```bash
.venv/bin/python manage.py migrate
SEED_PASSWORD='Dev-pass-123' .venv/bin/python manage.py seed      # idempotent; --reset-passwords to reset
```

This creates the same fictional accounts as the Node seed (`admin@`, `customer@`, `restaurant@`, `rider@`, `operations@`, `finance@` and `support@bitebox.test`). It also creates *Spice Route Kitchen* with 8 dishes, the coupons `WELCOME50` and `FLAT75`, a customer address and a rider vehicle. It refuses staging and production settings.

## Schema conventions

- **Base fields:** every table has a UUIDv7 `id`, `created_at`/`updated_at` (UTC), and a `legacy_id` holding the MongoDB id for imported rows (`common/models.py`).
- **Money:** integer paise (`*_paise`, `BigIntegerField`), with CHECK constraints. An order's total must add up exactly as the pricing service computes it.
- **Points:** use `common.geo.PointField`, with values as `GeoPoint(lat, lng)`. It's PostGIS `geography(Point,4326)` on PostgreSQL. No GDAL is needed.
- **Enums:** `TextChoices` with the same strings as Node, and the database refuses unknown values (`one_of(...)`).
- **Coin ledger:** rows are immutable. The model and queryset refuse edits and deletes, and on PostgreSQL a trigger enforces the same rule.
- **PostgreSQL-only DDL** (indexes, extensions, triggers) goes through `common/migration_ops.py`, so local SQLite test runs skip it.

## Endpoints so far

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Database, Redis and Celery workers. 503 if the database or Redis is down. |
| GET | `/api/v1/health/live` | Process is up (no dependencies) |
| GET | `/api/v1/health/ready` | Database and Redis reachable |
| GET | `/api/docs`, `/api/docs.json` | Swagger UI and the OpenAPI document |
| POST | `/api/v1/auth/register`, `/login`, `/refresh`, `/logout`, `/forgot-password`, `/reset-password`, `/change-password` | Sign-in and sessions (same contract as Node; refresh/logout need the `bb_refresh` cookie, `X-Requested-With: BiteBox` and a trusted Origin) |
| GET, PATCH | `/api/v1/auth/me` | Current user / update name and phone |
| GET | `/api/v1/admin/users` · PATCH `/admin/users/{id}/status` | Members (`users:manage`) |
| GET, POST | `/api/v1/admin/admins` · GET, PATCH `/admin/admins/{id}` · PATCH `/admin/admins/{id}/status` | Staff admins (`admins:manage`) |
| GET | `/api/v1/admin/audit-logs` | Audit log (`audit:view`) |
| GET | `/api/v1/restaurants`, `/restaurants/cuisines`, `/restaurants/{slugOrId}`, `/restaurants/{slugOrId}/menu`, `/categories`, `/foods`, `/foods/{id}` | Public catalogue (CDN-cacheable for 60 s) |
| GET, POST, PATCH | `/api/v1/my/restaurant` · PATCH `/my/restaurant/accepting-orders` · `/my/restaurant/foods[/{id}[/availability]]` | Partner restaurant and menu |
| GET, PATCH | `/api/v1/admin/restaurants[/counts\|/{id}[/status]]` · `/admin/categories[/{id}]` · `/admin/foods[/{id}[/availability]]` · `/admin/coupons[/{id}]` | Admin catalogue and coupons |
| POST | `/api/v1/uploads/images` (partner, admin), `/uploads/review-images` (customer) | Image upload (bytes checked; 2 MB) |
| GET | `/api/v1/geo/search`, `/geo/reverse`, `/geo/route` (signed in) | Place search and road routes (cached, rate limited) |
| GET, DELETE, POST, PATCH, PUT | `/api/v1/cart`, `/cart/items[/{foodItemId}]`, `/cart/coupon`, `/cart/coins` | The cart; every change returns the server-priced quote |
| GET, POST, PATCH, DELETE | `/api/v1/addresses[/{id}[/default]]` · GET `/coupons/available` | Saved addresses and coupons on offer |
| GET, POST | `/api/v1/orders` · GET `/orders/{id}` · POST `/orders/{id}/cancel` | Customer: place (`Idempotency-Key` header; cash on delivery), list, read, cancel before acceptance |
| GET, PATCH | `/api/v1/my/restaurant/orders[?view=active\|history]` · `/my/restaurant/orders/{id}[/status]` | Partner order board: accept, reject (reason), preparing, ready (dispatches a rider) |
| GET, PUT, PATCH, POST | `/api/v1/delivery/me[/vehicle\|/availability\|/location]` · `/delivery/offers/{id}/accept\|decline` · `/delivery/orders/{id}/status` · `/delivery/orders/history` | Rider app; actions answer with the fresh dashboard |
| GET | `/api/v1/my/restaurant/stats` · `/my/restaurant/earnings?days=` | Partner dashboard figures (orders received, today, pending, delivered, cancelled, sales, average order, rating) and earnings from settlements. `stats` exists only in Django. |
| GET | `/api/v1/delivery/reviews` · `/delivery/earnings?days=` · `/delivery/stats` | Rider ratings, earnings from settlements, and today/this week/all-time figures (`stats` exists only in Django). Rider order views also carry `estimatedEarningsPaise`; the offer on `/delivery/me` carries `pickupDistanceMeters` (straight line from the rider's last GPS fix). |
| GET, PUT, DELETE | `/api/v1/my/restaurant/reviews/orders[/{orderId}]` · `/reviews/summary` · `/reviews/{id}/response` | Partner reviews grouped per order, rating summary, public replies |
| GET | `/api/v1/admin/dashboard` (any admin role; money only with `finance:view`) · `/admin/reports?days=` (`finance:view`) · `/admin/operations/dashboard\|monitoring\|restaurants\|performance` (`operations:view`) | Platform summary (people, orders by state, GMV, platform revenue, settlements not yet paid out), analytics, live order board (late first), restaurant availability, delivery performance (aggregated in SQL) |
| GET | `/api/v1/admin/users/{id}/logins` (`users:manage`) · `/admin/admins/{id}/logins` (`admins:manage`) | Login history: one row per sign-in (session family), with device, IP and whether it is still active |
| GET | `/api/v1/orders/{id}/timeline` (customer) · `/admin/orders/{id}/timeline` | The order's history with readable labels and the expected ready time |
| POST | `/api/v1/admin/orders/{id}/assign` `{riderId}` · `/admin/orders/{id}/delivery-code` (`orders:manage`, audited) | Manual assignment of an online, free rider (withdraws any open offer); a new delivery code after too many wrong tries |
| GET, POST | `/api/v1/admin/orders[/{id}[/cancel\|/unassign]]` · `/admin/delivery-partners[/{id}/status]` | Order monitoring (`orders:view`/`orders:manage`), riders (`riders:manage`); changes are audited |
| WS | `/ws/` | Realtime socket (protocol below) |

### The `/ws/` protocol

- **Sign-in:** the first frame must be `{"type":"auth","token":"<access token>"}` within 5 s; a missing, bad or (later) expired token closes the socket with 4401, and the client refreshes and reconnects. `{"type":"ping"}` gets a pong.
- **Rooms** come only from the server-side identity: `user.<id>`, `restaurant.<id>` (the owner's restaurant) and `admins` (roles with `orders:view`), plus `order.<id>` after `track:join` passes a database check.
- **Requests with an answer** carry an `id`; the server replies `{"type":"ack","id","data"}`: `track:join` / `track:leave` `{orderId}`, and `rider:location` `{latitude, longitude, accuracy?}` (riders only; rate limited, imprecise or impossible jumps refused, stored at most every 5 s, broadcast to the active order's room).
- **Server events:** `{"type":"order:updated"|"order:location"|"notification:new","data"}`. Order events carry ids and statuses only; clients re-read over REST. Everything is sent after the database commit (`apps/realtime/events.py`).

### Orders and dispatch

- **Lifecycle (Phase 11):** `assigned → arrived_at_restaurant → picked_up` (arrival is optional, so riders' apps without it still work). At pickup the order gets a 4-digit `delivery_otp`; only the customer sees it (`deliveryOtp`), the rider sees `deliveryOtpRequired`, and `PATCH /delivery/orders/{id}/status {status: "delivered", otp}` checks it with a cap of `DELIVERY_OTP_MAX_ATTEMPTS` wrong tries (409 `OTP_LOCKED`; support issues a new code). `DELIVERY_OTP_REQUIRED=false` switches it off. Accepting takes `prepMinutes` (5–120; default the restaurant's usual time) and sets `readyBy`. Rider order views list `nextStatuses`.

- `apps/orders/workflow.py#transition` is the only place an order's status changes: a conditional update ("still in status X"), 409 `ORDER_CHANGED` for the loser of a race, a no-op for a repeat. Side effects (coupon release, payment, freeing the rider, the settlement split on delivery) run in savepoints and never undo the move.
- `apps/dispatch/services.py`: nearest free rider by PostGIS within 10 km, 500 m bands then longest idle; one offer at a time (`DeliveryAssignment`, one live row per order), compare-and-set locks on `DeliveryPartner.current_offer`/`active_order`. `sweep(now)` runs every 15 s from Celery Beat (`dispatch.sweep`): expires offers (that rider goes offline), re-dispatches, auto-rejects after 10 min, cancels unpaid online orders after 15 min and unpicked orders after 30 min. Tunables: `apps/dispatch/config.py`.

### Payments

- `apps/payments/services.py` owns every payment state change; `apps/payments/providers.py` picks the provider: Razorpay when `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set, otherwise the simulated provider (`PAYMENTS_MOCK`, always off in production). Tests swap it with `use_online_provider(...)` and a fake Razorpay client.
- Online orders keep `submitted_at` null until paid, so restaurants never see them; the sweep cancels them after 15 min. Payment is confirmed only server-side: the checkout signature plus the payment fetched from Razorpay, or a webhook (`POST /payments/webhooks/razorpay`, HMAC over the raw body, each event id stored once in `payment_webhook_events`). A payment that lands after the order closed is refunded at once.
- **Refunds** are rows (`refunds`). Opening one reserves its amount on `payments.refunded_paise` (a CHECK caps it at the amount paid) in the caller's transaction; the gateway is called after commit. Statuses: `pending → processing → processed | failed`; cash refunds are `manual_pending → manual_done` (`POST /admin/refunds/{id}/paid`). Finance refunds any amount up to what is left: `POST /admin/payments/{id}/refunds {amountPaise, reason}` (an `Idempotency-Key` header makes a retry safe). The payment becomes `partially_refunded` or `refunded`.
- **Reconciliation:** Celery Beat runs `payments.reconcile` every 5 min: unpaid online payments the gateway reports as captured, refunds whose gateway call never happened, and refunds the bank has not confirmed yet.
- Customers see their history at `GET /payments/mine`; admins at `GET /admin/payments` and `/admin/payments/{id}` (refunds and gateway events).

## Conventions (same contract as the Node API)

- **Envelope:** views return `common.api.ok(data, message=…, status=…)`.
- **Errors:** client-visible errors raise `common.api.ApiError` (or a DRF exception). The handler in `common/exceptions.py` turns everything into `{ success: false, message, error: { code, details? } }` with `Cache-Control: no-store`. Unknown errors become a generic 500 with no internal details.
- **Validation:** failures return 422 `VALIDATION_ERROR` with `details: [{ field, message }]`. One message per field, with paths like `deliveryAddress.postalCode` and `items[1].quantity`.
- **camelCase:** JSON is camelCase on the wire and snake_case in Python. This applies to bodies, responses and query parameters.
- **Paging:** `?page=&limit=` (clamped, maximum 100). Lists use `common.pagination.paginate()` and return `{ items, pagination: { page, limit, total, totalPages } }`.
- **Access:**
  - Roles use `role_required(Role.X)` and admin endpoints use `permission_required(Permission.X)` (`common/permissions.py`).
  - Roles and permissions live in `apps/rbac/roles.py`, and a test keeps them identical to `backend/config/*.js`.
- **Layout:**
  - Views stay thin. Business logic goes in each app's `services.py`, and reads in `selectors.py`.
  - Each app lives in `apps/<name>/`. Shared code is in `common/` and external providers in `integrations/`.

## Tests and databases

- `pytest` uses `config.settings.test`, which never touches a real database. **It requires `TEST_DATABASE_URL`** (PostgreSQL + PostGIS): the catalogue uses PostGIS and JSON operators SQLite doesn't have.
- With `TEST_DATABASE_URL` set, the database name **must end in `_test`**, or the run refuses to start. Without it, tests use in-memory SQLite.
- Redis, Celery (eager) and Channels (in-memory layer) run in-process.
- CI runs the suite against real PostGIS and Redis service containers (`.github/workflows/ci.yml`, job `backend-django`).

## Deployment

One image (`Dockerfile`) runs every process. The entrypoint selects it:

| Command | Process |
|---|---|
| `api` | uvicorn ASGI, `WEB_CONCURRENCY` workers |
| `worker` | Celery worker |
| `beat` | Celery beat (exactly one) |
| `migrate` | Database migrations, run as a separate release step and never on API start |

`config.settings.production` refuses to start without `DJANGO_SECRET_KEY` (32+ characters) and `DJANGO_ALLOWED_HOSTS`. CI runs `manage.py check --deploy` against it.
