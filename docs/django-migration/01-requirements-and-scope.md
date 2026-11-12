# 1. Requirement analysis, assumptions and scope

Phase 1 deliverables A (requirement analysis) and K (MVP scope). Source: [MASTER_PROMPT.md](../MASTER_PROMPT.md).

## 1.1 Confirmed facts about the current system

These are verified by reading the code (November 2026). They correct or confirm the gap table in MASTER_PROMPT §A3.

| Topic | Finding | Evidence |
|---|---|---|
| Backend | Express 5, Mongoose 9, 23 Mongoose models in 20 files, 24 routers, 37 services | `backend/models`, `backend/routes`, `backend/services` |
| Background work | Dispatch, payment-window and rewards sweeps run as `setInterval` loops inside the API process | `backend/server.js` |
| Serverless deploy | `backend/vercel.json` rewrites all traffic to a serverless function. **Sweeps and Socket.IO cannot run there.** The Docker deployment is the only complete one. | `backend/vercel.json` |
| Tests | 24 test files, about 350 `test()` cases, in-memory MongoDB | `backend/tests` |
| Payments | Methods `cod` and `online`. Providers `cash_on_delivery`, `razorpay` and `mock`. Statuses `pending`, `paid`, `failed`, `refunded`, `cancelled`. **Refunds are all-or-nothing** (one `providerRefundId`). | `backend/models/order.model.js` |
| Payment model location | The `Payment` schema is defined in `order.model.js`, not in its own file | same |
| Dispatch locks | `DeliveryPartner.currentOffer` and `activeOrder` are compare-and-set. `Order.offer.declinedBy[]` keeps riders who said no. | `delivery-partner.model.js`, `order.model.js` |
| Restaurant hours | A single `openingTime`/`closingTime` (HH:MM) plus `timezone`. No weekly schedule, no holidays. | `restaurant.model.js` |
| Restaurant status | `pending → approved/rejected`, `approved ↔ suspended`, `rejected → approved` (an edit resubmits it) | same |
| Menu | One price per dish, `isVeg`, `isAvailable`, one `imageUrl`, up to 10 `tags`, soft delete. **No variants, add-ons or stock.** | `food-item.model.js` |
| Cart | One cart per user, one restaurant. Line = `foodItem` + `quantity`. Plus `couponCode` and `coinsToRedeem`. | `cart.model.js` |
| Rider | `vehicleType` (bicycle, scooter, motorbike, car), `vehicleNumber`. **No KYC, documents or bank details.** | `delivery-partner.model.js` |
| Auth | Email + password (bcrypt). Rotating refresh tokens with families (`Session`). `tokenVersion` revocation. Email reset link. **No OTP, no email verification, no login history** beyond `lastLoginAt`. | `user.model.js`, `session.model.js`, `auth.service.js` |
| Tracking | Rider position is stored only as the latest point on `DeliveryPartner`. **No location history.** | `delivery-partner.model.js` |
| Notifications | In-app `Notification` (90-day TTL), Web Push (`PushSubscription`, VAPID), SMTP mail for password reset. **No SMS, no templates, no delivery log.** | `notification.model.js`, `push.service.js`, `mail.service.js` |
| Finance | `order.settlement` + `Payout` (restaurant or rider, pending/paid/cancelled). **No invoices, no per-restaurant commission, no ledger table.** | `payout.model.js`, `config/earnings.js` |
| Frontend forms | **Zero Reactive Forms**, 61 files use Signal Forms | grep |
| Angular Material | 107 source files. Imports: button 88, dialog 68, paginator 26, progress-spinner 9, menu 6, button-toggle 5, progress-bar 4, tabs 3, tooltip/divider/chips 2 each, toolbar/table/snack-bar/sidenav/radio/list 1 each | grep |
| Theme | Light only (`color-scheme: light` in `styles.scss`). **No dark mode.** | `frontend/src/styles.scss` |
| NexPrime | v0.1.5. Dark mode via `data-theme="dark"` on `<html>`. Dialogs are template-only (`np-dialog`, `np-modal`); there is **no programmatic open service** like `MatDialog.open()`. `ConfirmationService` exists. | `node_modules/nexprime/types/nexprime.d.ts` |

## 1.2 Assumptions (to confirm)

1. **Goal.** Replace the Node backend with Django, keep the Angular app, add the missing features. Launch in one Indian city and grow to more cities without a rewrite.
2. **Single country and currency.** India, INR, `Asia/Kolkata` as the default reporting time zone.
3. **API compatibility.** The Django API keeps the existing paths, camelCase JSON and envelope, so the Angular app changes only where features are new (MASTER_PROMPT §A4.2).
4. **Existing data.** Production MongoDB data (if any) must be migrated. If BiteBox has no real users yet, the import is reduced to the seed data and becomes optional. **Please confirm whether there is live production data.**
5. **Hosting.** A single cloud VM or managed container service with managed PostgreSQL and Redis. Vercel serverless is not suitable for the Django backend: Channels and Celery need long-running processes.
6. **Phone numbers.** Indian mobile numbers (E.164 `+91…`) for OTP login. Email remains a supported login.
7. **KYC.** Document review is manual by operations admins. No automated verification provider (e.g. DigiLocker or a third-party API) in the MVP.
8. **Invoices.** A PDF tax invoice for the customer and a monthly commission invoice for each restaurant. Exact GST treatment needs review by a professional (see §17 of the master prompt).
9. **Contact masking.** No call-masking provider in the MVP. The rider sees the customer's phone number only while carrying the order (today's rule).

## 1.3 Open questions

| # | Question | Default if not answered |
|---|---|---|
| Q1 | Is there production MongoDB data to migrate? | Build the importer, verify it on seed data only |
| Q2 | Hosting target (AWS, Azure, DigitalOcean)? | DigitalOcean: App Platform or a Droplet, managed PostgreSQL and Redis, Spaces (S3) |
| Q3 | SMS provider for OTP (MSG91, Twilio, other)? DLT template registration is required in India. | MSG91 adapter + console mock in development |
| Q4 | Add Cashfree as well as Razorpay? | Razorpay only. Keep the provider interface ready. |
| Q5 | Money storage: integer paise or `DecimalField`? | Integer paise (see [README §Decisions](README.md#decisions-needing-approval)) |
| Q6 | Keep the single Angular app or split it into a multi-project workspace? | Keep the single app |
| Q7 | Accept the proposed order statuses (arrival and delivery OTP)? | See [02-architecture.md §2.3](02-architecture.md#23-order-lifecycle-proposed) |
| Q8 | Is "partial refund" limited to admin-initiated amounts, or also item-level customer requests? | Admin-initiated amounts (with a reason), up to the amount paid |
| Q9 | Should COD be limited (per-user cap, new-user block)? | Configurable maximum COD order value in `app_settings` |

## 1.4 Functional requirements by panel

Legend: **P** = parity with today, **N** = new.

### Customer
| Requirement | Type | Notes |
|---|---|---|
| Email + password register and login, refresh, logout, reset | P | |
| Mobile OTP login (send, verify, resend cooldown, attempt limit) | N | Creates the account on first verify if `register=true` |
| Email verification link | N | Unverified accounts can order. Shown as a banner. |
| Addresses (≤10, default, map pin, search) | P | |
| Restaurant discovery by location, filters, sort | P | |
| Banners and "recently ordered" on home | N | Admin-managed banners |
| Variants, add-ons, special instructions per line | N | Changes cart, quote and order snapshot |
| Cart quote, coupon, coins | P | |
| Order placement (idempotent), COD and online | P | |
| Tracking, timeline, ETA (labelled) | P | |
| Delivery OTP shown on the active order | N | 4 digits, rotates if regenerated |
| Reorder | N | Copies still-available items into the cart and shows what changed |
| Refund tracking (status and amount) | N | Needs partial-refund rows |
| Favourite restaurants and dishes | N | |
| Payment history | N | Read-only list from `payments` |
| Reviews, coins, referrals, rewards, support, inbox, push | P | |

### Restaurant
| Requirement | Type | Notes |
|---|---|---|
| Restaurant profile, approval, resubmission | P | |
| GST, FSSAI, bank details, KYC documents, photos | N | Documents in a private bucket |
| Status `needs_resubmission` | N | Admin asks for specific documents |
| Weekly hours (multiple slots per day), holidays | N | Replaces `openingTime`/`closingTime` (migrated as 7 identical days) |
| Delivery radius (≤ platform maximum), minimum order, preparation time | P/N | Radius is new |
| Menu with variants, add-on groups, stock | N | |
| Live order board, accept/reject, preparing, ready | P | |
| Handover confirmation | N | Pickup is recorded by the rider. The restaurant sees it in real time and can flag a dispute. |
| Earnings | P | |
| Settlement history, invoices (PDF), sales report export (CSV) | N | |

### Delivery partner
| Requirement | Type | Notes |
|---|---|---|
| Vehicle, online/offline, GPS, offers, accept/decline, pickup, deliver, history, earnings | P | |
| KYC: photo, licence, RC, ID document, bank account | N | Required before going online |
| Arrived at restaurant | N | New status |
| Delivery OTP check before "delivered" | N | 5 wrong attempts lock the step; the rider must contact support |
| Report a failed delivery (customer unreachable) | N | Creates a support case. An admin decides cancel or retry. |
| Incentives | N | Admin-defined targets (e.g. N deliveries per day → bonus), paid with the payout |
| Payout history, bank account management | N | |

### Admin
| Requirement | Type | Notes |
|---|---|---|
| Staff roles, permissions, audit log, users, restaurants, riders, orders, payments, reports, operations, finance, support, rewards, reviews, push promotions | P | |
| KYC review screens (restaurant and rider) | N | New permission `kyc:review` (operations) |
| Per-restaurant commission | N | `commission_rules` table, with the global default from `app_settings` |
| Editable fees and pricing (`app_settings`) | N | Super admin and finance (`settings:manage`) |
| Manual rider assignment | N | Bypasses the queue. Respects locks and eligibility. |
| Partial refunds, reconciliation | N | |
| Disputes | N | A support ticket type `dispute` linked to an order, with refund actions |
| Banners, feature flags | N | `settings:manage` |
| Login history | N | Per user. Visible to `users:manage`. |

## 1.5 Non-functional requirements

| Area | Target (to confirm in Phase 1 approval) |
|---|---|
| API latency | p95 < 300 ms for catalogue and cart reads, < 800 ms for order placement, at 100 req/s on one 2 vCPU instance |
| Real-time | Status event delivered < 2 s after commit. Rider location fan-out < 1 s. |
| Concurrency | No double booking of riders, coupons, coins or payments under 50 concurrent checkouts on the same coupon (tested) |
| Availability | 99.5% monthly for the launch city |
| Data | Daily full backup + WAL/PITR on managed PostgreSQL. RPO ≤ 15 min, RTO ≤ 2 h. Restore drill before launch. |
| Accessibility | WCAG 2.1 AA (current standard kept) |
| Privacy | Personal data minimised per role (current `presentFor*` rules). Rider GPS history kept 30 days. KYC documents are private with signed URLs. |

## 1.6 MVP versus later releases

**MVP (release 1): Django parity + switch-over + launch blockers**
1. Django backend at full parity with the Node API (every endpoint in DOCUMENTATION §14, same contract), passing the ported test suite.
2. PostgreSQL + Redis + Celery + Channels in Docker. The frontend's realtime client switches to native WebSocket.
3. Mongo importer (if Q1 = yes).
4. Delivery OTP and the arrival step (they affect safety and disputes).
5. Restaurant and rider KYC with manual review (FSSAI is a legal prerequisite for listing food businesses).
6. Partial refunds and payment reconciliation.
7. Dark theme and completion of the NexPrime migration for **customer and rider** screens.
8. Sentry, metrics, backups with a restore drill.

**Release 2**
- Mobile OTP login and email verification (needs the SMS provider and DLT templates; Q3).
- Variants, add-ons and stock.
- Weekly hours, holidays and delivery radius.
- Favourites, reorder, banners and recently ordered.
- Editable fees and per-restaurant commission. Invoices (PDF) and settlement history.
- NexPrime migration for the restaurant and admin panels (Material removed entirely).

**Release 3 and later**
- Rider incentives, manual assignment, disputes workflow, login history, feature flags.
- FCM for native apps, call masking, Cashfree, multi-city settings (per-city fees and radius).
- Load-tested horizontal scaling (multiple ASGI and worker instances).

Rationale: release 1 replaces the platform without changing the user experience much. That keeps the switch-over risk measurable: the same tests and the same screens run against a new backend. Features that need third-party onboarding (SMS DLT, invoices needing tax review) come after.
