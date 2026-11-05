# Coins, Referral & Special Rewards — implementation plan

Status: **all phases (1–7) implemented.** Where the implementation differs from the request (endpoint paths, coin timing), this plan records the reason.

## 1. What exists today (inspection summary)

| Area | Finding | Consequence for rewards |
|------|---------|-------------------------|
| Wallet / loyalty | Nothing exists. | All new; no duplication risk. |
| Discounts | Coupons: `cart.couponCode` → re-validated in `cart.service#buildQuote` → reserved inside `order.service#commitOrder` (with undo steps) → released in `order-workflow#afterTransition`. | Coin redemption follows the same path: chosen on the cart, priced in the quote, reserved at order commit, closed by the workflow. |
| Order lifecycle | `order-workflow.service#transition` is the only place statuses change; side effects in `afterTransition` are idempotent and best-effort. | Hooks: `DELIVERED` → order reward + referral qualification + order campaigns; `CANCELLED/REJECTED` → release or restore redeemed coins. |
| Payments | `payment.service#markPaid` (exactly once) sends online orders to the restaurant; unpaid online orders are cancelled by the sweep after `paymentWindowMinutes`. A failed attempt can be retried ("Pay now") while the order is pending. | Coins are **reserved** at placement and **committed** in `markPaid` (online) or at placement (COD). The payment window is the reservation expiry. |
| Refunds | Only full refunds of cancelled/rejected online orders. No partial refunds, no refunds after delivery. | Partial reversal is implemented in the ledger (`reverseCredit`) but has no caller until a delivered-order refund feature exists. |
| Settlement | `earnings#settlementFor`: platform share = `totalPaise − restaurant − rider`. Restaurant share uses subtotal − coupon. | Coin discounts reduce only the platform share. Restaurant and rider payouts are unaffected. |
| Transactions | `withTransaction` uses a session on replica sets and otherwise falls back to compensating steps. Tests run on a standalone in-memory Mongo. | The ledger must be correct **without** transactions (see §3), and joins a session when one is passed. |
| Jobs | One `setInterval` loop (`dispatch.service#startDispatchLoop`) started in `server.js`; never overlaps itself. | A second loop, `startRewardsLoop`, uses the same pattern. No cron library and no queue. |
| Admin access | `can(PERMISSIONS.X)`, super admin has every permission, `audited(...)` on mutating routes. | New `rewards:manage` (super admin only) and `rewards:view` (super admin + finance admin, read-only reports). |
| API style | Resource paths (`/api/v1/cart`, `/api/v1/orders`), not `/customer/...`; envelope `{success,message,data}`; express-validator. | Customer endpoints are `/api/v1/coins`, `/api/v1/referrals`, `/api/v1/rewards`. |

## 2. Data model

Money is in integer paise and coins are integers. All rewards models are new; `User` gains a few optional fields.

- **RewardConfiguration** (`models/reward-configuration.model.js`): a single document (`key: "global"`). Defaults are in `config/rewards.js`, and stored values override them. It carries `version` for optimistic concurrency and `updatedBy`. It holds sections for coins, order earning, review earning, redemption, expiry, referral, birthday and welcome.
- **CoinWallet** (`models/coin-wallet.model.js`): one per user (unique `user`).
  - Balances: `available`, `reserved`, `totalEarned`, `totalRedeemed` (net of refunds), `totalExpired`, `totalReversed`, `uncollectedReversal`.
  - `seq`: the per-wallet ledger sequence.
  - `batches[]`: the live credit batches (`_id` = credit txn id, `source`, `original`, `remaining`, `earnedAt`, `expiresAt`). Fully used batches are pruned, and their history stays in the ledger.
- **CoinTransaction** (`models/coin-transaction.model.js`): the immutable ledger.
  - Fields: `user`, `wallet`, `seq` (unique with the wallet), `type`, `source`, `coins`, before and after values for available and reserved, `order` / `campaign` / `referral` / `relatedTxn`, `idempotencyKey` (unique), `allocations[]` (which batches a debit used), `expiresAt` (credits), `description`, `meta` (admin-only), `createdBy`, `status` (`pending` → `posted`).
  - Updates other than `pending → posted`, and all deletes, are rejected by model middleware.
- **Referral** (Phase 3): `referrer`, `referred` (unique, so a customer has one referrer), `code`, `status`, `qualifyingOrder`, `referrerCoins`, `referredCoins`, `rewardStatus`, `attributionExpiresAt`, `riskFlags` (admin-only), plus history.
- **RewardCampaign** and **RewardClaim** (Phase 4):
  - A claim is unique on `(campaign, user, claimNumber)`. Total claims use an atomic `$inc` guarded by `claimsCount < maxTotalClaims`.
  - Birthday and welcome rewards use claims with keys `birthday:<user>:<year>` and `welcome:<user>`.
- **User** additions (Phases 3–4): `referralCode` (unique, sparse), `birthDate` (customer sets it once; support can change it).

## 3. Ledger design (Phase 1)

**Transaction types** and their effect on the balances:

| Type | Effect |
|------|--------|
| `CREDIT` | `available += c`, `totalEarned += c`, adds a batch |
| `RESERVE` | `available −= c`, `reserved += c`, uses batches FIFO |
| `DEBIT` | `reserved −= c`, `totalRedeemed += c` (commits a reservation) |
| `RELEASE` | `reserved −= c`, `available += c`, returns coins to their batches |
| `EXPIRE` | `available −= batch.remaining`, `totalExpired += …` |
| `REVERSAL` | Either claws back an earned credit (`available −= min(c, available)`, with any shortfall added to `uncollectedReversal`), or refunds a committed redemption (`available += c`, `totalRedeemed −= c`, coins return to their batches). |

**Concurrency without transactions: a per-wallet sequence lock.** Each operation runs these steps:

1. Read the wallet at `seq = n`, then compute the effect: check the balance, compute FIFO allocations, and calculate the new totals. If the effect is invalid (insufficient coins), throw before writing anything.
2. Insert the ledger row with `seq = n+1` and `status: pending`. The unique `(wallet, seq)` index means only one operation can claim `n+1`.
   - A duplicate `seq` means someone else won: finish their pending row and retry.
   - A duplicate `idempotencyKey` means a replay: return the existing row.
3. Apply the effect with `Wallet.updateOne({ _id, seq: n }, { $set: … , seq: n+1 })`.
4. Mark the row `posted`.

A crash between steps 2 and 4 leaves a pending row that the next operation on that wallet (or the sweep) finishes deterministically. The effect is recomputed from the wallet at `seq = n`, and nobody else can change it in the meantime. The balance can never go negative, because every check runs while holding the sequence.

When a Mongo session is passed (replica sets, inside `withTransaction`), the same steps run in the transaction and the row is inserted as `posted` directly.

**Invariants** (checked by `reconcile()` and by the tests):

- `available == Σ batches.remaining`
- `totalEarned − totalRedeemed − totalExpired − totalReversed == available + reserved`
- Replaying the posted rows reproduces the wallet.

**FIFO:** batches are used in order of earliest `expiresAt` (never-expiring last), then `earnedAt`. Coins returned by a release or refund go back to their batch with `expiresAt = max(original, now + restoreGraceDays)`.

## 4. Checkout integration (Phase 2)

- `PUT /api/v1/cart/coins { coins }` / `DELETE /api/v1/cart/coins` stores the customer's requested amount on the cart, like coupons do. Customers never call reserve or release directly.
- `buildQuote` returns `coins: { available, requested, applied, maxRedeemable, discountPaise, minCoins, reason }`. It also returns `pricing.coinDiscountPaise`, and `totalPaise` is net of it.
  - Coins reduce the payable amount after tax. They do not change the tax, the delivery fee or the free-delivery threshold.
  - The redemption percentage cap applies to (subtotal − coupon).
- `commitOrder` reserves the coins with key `reserve:<orderId>`. The undo step releases them, and the payment amount is the net total.
  - Order state: `order.coins = { coins, discountPaise, state: reserved|committed|released|refunded }`.
  - COD orders commit at placement. Online orders commit in `markPaid`.
  - A cancelled or rejected order either releases the reservation or refunds the committed coins (`afterTransition`).
  - A sweep safety net releases reservations whose order is already final.
- **Order reward** on `DELIVERED`: key `order-reward:<orderId>`. The base is subtotal − coupon − coin discount. Coins are `floor(base / unitPaise) × coinsPerUnit`, capped per order, with a minimum order amount.
- **Review reward:** key `review-reward:<orderId>`, for the restaurant review of a delivered order, with an optional minimum comment length. Removing the review in moderation can reverse the reward.
- Customer API: `GET /api/v1/coins/wallet`, `GET /api/v1/coins/transactions` (paginated, filterable).

## 5. Referral (Phase 3)

- Every customer gets a code like `BITEBOX-RIYA7K2Q`, generated lazily and on registration, unique in the database.
- `POST /api/v1/auth/register` accepts an optional `referralCode`. `POST /api/v1/referrals/validate` is public and rate-limited, and returns only `valid`.
- Statuses: `REGISTERED` → `FIRST_ORDER_PLACED` → `ORDER_DELIVERED` → `REWARD_CREDITED`, or `REJECTED` / `EXPIRED`.
  - The reward is checked on delivery of the first qualifying order (minimum value, not cancelled, within the attribution window).
  - Keys: `referral-referrer:<referralId>` and `referral-referred:<referralId>`.
- **Fraud checks:**
  - Self-referral.
  - Referrer inactive or not a customer.
  - Per-referrer limit and per-period reward limit.
  - Same phone.
  - Delivery address within about 50 m of the referrer's addresses.
  - The same address reused across referrals.

  A failed check puts the referral on hold (`riskFlags`, admin review) instead of rewarding it. Flags are never sent to customers.
- `GET /api/v1/referrals/me`, `/referrals/me/history`.

## 6. Special rewards (Phase 4)

- **Welcome:** on registration or on the first delivered order (configurable), once per customer.
- **Birthday:** a sweep in the configured timezone gives the reward once per calendar year. People born on 29 Feb get it on 28 Feb in non-leap years.
- **Campaigns** (`FESTIVAL`, `PROMOTIONAL`):
  - Trigger: `claim` (the customer taps "Claim") or `order` (automatic on a qualifying delivered order).
  - Eligibility: customer group (all / new / existing / inactive N days), restaurants, minimum order value, first order only.
  - Limits: per customer, total, and maximum reward.
  - Statuses: `DRAFT`, `SCHEDULED`, `ACTIVE`, `PAUSED`, `EXPIRED`, `COMPLETED`. The sweep moves campaigns between scheduled, active, expired and completed.
- `GET /api/v1/rewards` (overview), `/rewards/campaigns`, `POST /rewards/campaigns/:id/claim`, `/rewards/history`.

## 7. Background jobs

`services/rewards-jobs.service.js#rewardsSweep(now)`, started by `startRewardsLoop()` in `server.js` (every 5 minutes, never overlapping). Tests call `rewardsSweep(now)` directly. Steps:

1. Finish any pending ledger rows.
2. Expire batches.
3. Release reservations of final orders.
4. Activate, expire and complete campaigns.
5. Give birthday rewards.
6. Expire referral attributions.

Each step is bounded and idempotent through ledger keys and conditional updates, and logs a summary. Running it on several instances is harmless.

## 8. Admin (Phase 5)

`/api/v1/admin/rewards/*`. Configuration, campaigns and manual reversals need `rewards:manage` and are audited. Reports and transactions need `rewards:view`.

- `GET|PUT /configuration` (with `version`)
- `GET|POST /campaigns`, `GET|PUT /campaigns/:id`, `PATCH /campaigns/:id/status`
- `GET /transactions`, `GET /transactions/:id`
- `GET /reports`: issued, redeemed, outstanding liability (coins and ₹), referral and promotional totals, expired, reversed, active wallets, campaign performance, suspicious activity
- `GET /referrals`, `PATCH /referrals/:id` (approve or reject held referrals)

The frontend gets a "Coins & Rewards" admin section with Configuration, Campaigns, Referrals, Transactions and Reports pages.

## 9. Customer UI (Phase 6)

- Account pages: My Coins & Wallet, Refer & Earn, Special Rewards. They use stat tiles, `pagedList` tables and campaign cards.
- Checkout: a coins card with the balance, max redeemable, a coins input, apply/remove, and a "Coins discount" price line.
- Order detail: coins used and coins earned.
- Register page: reads `?ref=CODE` and validates it.
- All built with NexPrime and Signal Forms.

## 10. Testing (each phase, and Phase 7)

Each phase ships `node:test` suites on in-memory Mongo, plus one replica-set suite for the transaction path. The scenarios are the 33 in the request, mapped to: `coin-wallet.test.js` (ledger), `coins-checkout.test.js`, `referrals.test.js`, `reward-campaigns.test.js` and `rewards-admin.test.js`. Phase 7 adds frontend specs and a headless checkout check against a throwaway API.
