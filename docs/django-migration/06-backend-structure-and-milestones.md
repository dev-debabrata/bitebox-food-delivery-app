# 6. Django backend structure and milestones

Phase 1 deliverables H (folder structure) and I (milestones and task breakdown).

## 6.1 Dependencies (to be verified for compatibility in Phase 3)

| Package | Purpose | Note |
|---|---|---|
| Python 3.13 | runtime | |
| Django 5.2 LTS | framework | LTS supported to April 2028. Move to the next LTS when the ecosystem supports it. |
| djangorestframework | API | |
| djangorestframework-simplejwt | access tokens | The refresh flow is custom (cookie + session families), so only the access-token classes are used |
| djangorestframework-camel-case | camelCase contract | |
| drf-spectacular | OpenAPI | |
| django-filter | admin list filters | |
| channels, channels-redis, uvicorn[standard] | WebSockets / ASGI | |
| celery, django-celery-beat, redis | background jobs | Beat schedule in code. `django-celery-beat` is only for admin-visible schedules. |
| psycopg[binary] 3, PostGIS (GeoDjango) | database | GDAL/GEOS in the image |
| django-environ | settings | |
| django-storages[s3], boto3, Pillow, python-magic | uploads | |
| argon2-cffi, bcrypt | password hashing | bcrypt only to verify imported hashes |
| cryptography | field encryption (bank and document numbers) | Key from `FIELD_ENCRYPTION_KEY`, with rotation support |
| razorpay | payments | |
| pywebpush | Web Push | |
| weasyprint or reportlab | invoices (PDF) | Decided in Phase 10 |
| sentry-sdk, django-prometheus, structlog | observability | |
| pytest, pytest-django, pytest-asyncio, factory-boy, freezegun, responses | tests | |
| ruff, mypy (django-stubs), pip-audit | quality | |
| pymongo | `import_mongo` command only (dev requirements) | |

## 6.2 Folder structure

```text
backend-django/
├── manage.py
├── pyproject.toml                 # ruff, pytest, mypy config
├── requirements/
│   ├── base.txt  dev.txt  prod.txt
├── .env.example                   # every variable, no real secrets
├── Dockerfile                     # multi-stage; non-root; GDAL; collectstatic
├── docker/
│   ├── entrypoint.sh              # wait for db, migrate (release job only), start
│   └── gunicorn/uvicorn config
├── config/
│   ├── settings/
│   │   ├── base.py  development.py  test.py  staging.py  production.py
│   ├── urls.py                    # /api/v1/ includes, /api/docs
│   ├── asgi.py                    # ProtocolTypeRouter: http + websocket (/ws/)
│   ├── wsgi.py
│   ├── celery.py                  # app, queues, beat_schedule
│   └── routing.py                 # websocket URL patterns
├── common/
│   ├── api.py                     # ApiError, envelope helpers
│   ├── renderers.py               # EnvelopeRenderer (camelCase)
│   ├── exceptions.py              # EXCEPTION_HANDLER
│   ├── pagination.py              # page/limit → {items,total,page,limit}
│   ├── permissions.py             # IsRole, HasPermission
│   ├── throttling.py
│   ├── idempotency.py
│   ├── money.py                   # paise helpers, rounding rules
│   ├── geo.py                     # point helpers, straight-line distance
│   ├── fields.py                  # EncryptedField
│   ├── events.py                  # in-process domain event dispatcher (on_commit)
│   ├── models.py                  # UUIDModel, TimeStampedModel, LegacyIdMixin
│   └── testing/                   # factories base, api client helpers
├── integrations/
│   ├── payments/  base.py razorpay.py mock.py
│   ├── geo/       base.py nominatim.py osrm.py static.py
│   ├── sms/       base.py msg91.py console.py
│   ├── email/     backends (Django EMAIL_BACKEND) + templates
│   ├── push/      webpush.py fcm.py (later)
│   └── storage/   public/private storage classes, signed URLs
├── apps/
│   ├── accounts/      User, Session, OtpVerification, LoginHistory; auth views; refresh cookie
│   ├── rbac/          ROLES, PERMISSIONS, ROLE_PERMISSIONS (code), helpers
│   ├── customers/     Address, Favorite
│   ├── restaurants/   Restaurant, Hours, Holiday, Document, BankAccount (shared model)
│   ├── menus/         FoodCategory, FoodItem, FoodImage, Variant, AddonGroup, Addon
│   ├── cart/          Cart, CartItem, CartItemAddon; quote
│   ├── pricing/       fee, tax and total calculation (pure functions + settings)
│   ├── coupons/       Coupon, CouponRedemption, Banner
│   ├── orders/        Order, OrderItem…, StatusHistory, Cancellation; workflow.py; presenters
│   ├── dispatch/      DeliveryAssignment; dispatch.py; sweep()
│   ├── delivery/      DeliveryPartner, RiderVehicle, RiderDocument
│   ├── tracking/      TrackingPoint; consumers.py; location validation
│   ├── payments/      Payment, Attempt, WebhookEvent, Refund; service.py; webhook view
│   ├── finance/       CommissionRule, OrderSettlement, Payout, LedgerEntry, Invoice, IncentiveRule
│   ├── coins/         Wallet, Batch, Transaction, Allocation, Referral, Campaign, Claim, RewardConfig
│   ├── reviews/       Review, Response, Edit, ModerationLog, Report
│   ├── support/       Ticket, Message, History
│   ├── notifications/ Notification, Template, Delivery, PushSubscription, DeviceToken; notify()
│   ├── realtime/      WebSocket consumer (auth, groups, ping), emit helpers
│   ├── geo/           /geo views over integrations.geo
│   ├── uploads/       image upload views
│   ├── analytics/     reports, dashboards (selectors only)
│   ├── audit/         AuditLog, @audited
│   ├── system_settings/ AppSetting, AppSettingHistory, FeatureFlag
│   └── newsletter/    NewsletterSubscription
│       # each app: models.py serializers.py views.py urls.py services.py selectors.py
│       #           permissions.py tasks.py admin.py tests/ (as needed; no empty files)
├── scripts/
│   └── (management commands live in apps/*/management/commands: seed, import_mongo)
└── tests/
    ├── conftest.py                # db, api clients per role, fake providers, celery eager
    ├── parity/                    # ported Node suites, one file per old test file
    ├── e2e_api/                   # cross-module flows (order → delivery → settlement)
    └── concurrency/               # threaded race tests with transaction=True
```

The master prompt lists separate `users`, `addresses`, `food_categories`, `refunds`, `ratings`, `commissions`, `settlements`, `admin_panel` and `audit_logs` apps. These are **merged** into the owning apps above to avoid circular dependencies and empty modules (master prompt rule: "Do not create unnecessary abstraction"). Admin views live in each app under `views_admin.py` / `urls_admin.py`, mounted at `/api/v1/admin/...`.

## 6.3 Celery tasks and schedule

| Task | Schedule | Replaces |
|---|---|---|
| `dispatch.sweep` | every 15 s | `setInterval` dispatch sweep |
| `orders.expire_unpaid` | every 60 s | payment-window loop |
| `orders.auto_reject_unanswered` | inside `dispatch.sweep` | |
| `coins.rewards_sweep` | every 5 min | `rewardsSweep` |
| `payments.reconcile` | nightly 02:00 IST | new |
| `payments.retry_refunds` | every 10 min | new |
| `notifications.send` (per channel) | on demand, retries with exponential backoff (max 5), then a dead-letter row | in-process push |
| `accounts.purge_sessions`, `notifications.purge_old`, `tracking.purge_points`, `kyc.expire_documents` | daily | MongoDB TTL indexes |
| `finance.build_invoices` | monthly, 1st, 03:00 IST | new |

Every periodic task is idempotent and takes a Redis lock (`SET NX EX`), so overlapping runs or two Beat instances by mistake can't double-process. Pure functions (`sweep(now)`) stay directly callable from tests.

## 6.4 Milestones and task breakdown

Estimates assume one full-time developer with AI assistance. They are indicative, to be re-estimated at the start of each phase.

| Phase | Deliverables | Exit criteria | Est. |
|---|---|---|---|
| **1. Analysis** (this) | Documents in `docs/django-migration/` | Approved decisions (README) | done |
| **2. UI/UX + theme** | Wireframes for new screens (§5.3), dark theme tokens, `ThemeService`, migration wrappers (`BbDialog`, toast host) | Screens reviewed. Dark mode toggles without layout shift. | 1 wk |
| **3. Django skeleton** | Project, settings, Docker Compose (postgres + PostGIS, redis, api, worker, beat), envelope, renderer, exception handler, pagination, permissions, `/health`, OpenAPI, CI job (ruff, mypy, pytest, pip-audit) | `docker compose up` works. CI green. Health returns db, redis and celery OK. | 1 wk |
| **4. Parity schema** | All models for existing features + migrations, factories, `seed` command (fictional data, same accounts as today) | `migrate` on an empty DB succeeds. Seed is idempotent. Model constraint tests pass. | 1.5 wk |
| **5. Auth + RBAC** | Register, login, refresh cookie with families, logout, reset, change password, `/auth/me`, admin users and admins, audit log. Then OTP and email verification. | Ported `auth`, `admin-roles`, `admin` and `validate` suites pass. Frontend login works against Django. | 1.5 wk |
| **6. Catalogue + cart** | Restaurants, menus, categories, uploads, geo, addresses, cart quote, coupons. Then variants, add-ons and stock. | Ported `catalog`, `checkout`, `geo` suites pass. Food dialog with variants works. | 2 wk |
| **7. Orders, dispatch, realtime** | Order placement, workflow (with arrival + OTP), dispatch, Beat sweep, Channels consumer, frontend WebSocket client | Ported `orders`, `realtime`, `tracking` suites. Concurrency tests (double accept, double transition). Full order flow in the browser. | 2.5 wk |
| **8. Payments** | Provider abstraction, Razorpay, mock, webhooks, partial refunds, reconciliation | Ported `payments` suite. Webhook replay test. Refund over-limit test. Sandbox payment verified manually. | 1.5 wk |
| **9. Engagement** | Coins ledger, referrals, campaigns, reviews, support, notifications (templates, email, SMS adapters, push), newsletter | Ported `coin-wallet`, `coins-checkout`, `referrals`, `rewards-*`, `special-rewards`, `reviews`, `push`, `newsletter` suites | 2.5 wk |
| **10. Finance** | Settlements, ledger entries, commission rules, payouts, invoices, reports, settings | Report totals equal ledger totals in tests. Invoice PDF renders. | 1.5 wk |
| **11. KYC** | Documents (private storage, signed URLs, encryption), restaurant and rider KYC flows, admin review | Unapproved riders can't go online. Document access is audited. | 1.5 wk |
| **12. Customer extras** | Favourites, reorder, banners, recent orders, payment history, login history, feature flags | Unit + API tests. Screens done. | 1 wk |
| **13. NexPrime completion** | Material removed (restaurant + admin panels) | `grep @angular/material` = 0. Screenshot suite passes. Bundle budget met. | 2 wk |
| **14. Data migration + staging** | `import_mongo` (if Q1), staging environment, E2E Playwright suite, load tests | Import verification report clean. E2E green. Load targets met. | 1.5 wk |
| **15. Security + ops** | Security review (§7), Sentry, metrics dashboards, backups + restore drill, runbooks | Checklist signed. Restore tested and timed. | 1 wk |
| **16. Cut-over** | Production deploy, DNS/nginx switch, Node kept as rollback for one release, then removed. Docs updated. | Smoke tests in production. 7 days stable. `backend/` removed in a later PR. | 1 wk |

Total: about 24 weeks of focused work. The MVP (phases 1–8, 11, 14–16 with the customer and rider NexPrime work) is about 17 weeks.

**Task breakdown pattern inside each module phase**
1. Port the Node tests for the module into `tests/parity/` (red).
2. Models + migrations + factories.
3. Selectors and services (business rules), with unit tests.
4. Serializers, views, URLs, permissions, `extend_schema`.
5. Parity suite green, plus new-feature tests.
6. Point the dev frontend at Django for that module and click through.
7. Update `docs/DOCUMENTATION.md`, `.env.example` and OpenAPI. Write the phase report.
