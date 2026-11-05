import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import mongoose from "mongoose";
import { COIN_SOURCES } from "../config/rewards.js";
import { CoinTransaction } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import * as wallet from "../services/coin-wallet.service.js";
import { updateRewardConfig } from "../services/reward-config.service.js";
import { transactionsSupported, withTransaction } from "../utils/transaction.js";
import { resetDb, setupTestDb, teardownTestDb } from "./helpers.js";

const S = COIN_SOURCES;
const DAY = 86_400_000;
const newId = () => new mongoose.Types.ObjectId();
const at = (days, from = new Date("2026-11-05T06:00:00Z")) => new Date(from.getTime() + days * DAY);
const NOW = at(0);

async function balance(userId) {
  return CoinWallet.findOne({ user: userId }).lean();
}
async function assertReconciled(userId) {
  const result = await wallet.reconcile(userId);
  assert.deepEqual(result.issues, [], "wallet does not match its ledger");
}
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });

describe("coin wallet ledger", () => {
  let user;

  before(setupTestDb);
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    user = newId();
  });

  const earn = (coins, key, extra = {}) =>
    wallet.credit(user, { coins, source: S.ORDER_REWARD, key, ...extra }, { now: extra.now ?? NOW });

  describe("credits", () => {
    it("creates the wallet, a batch and a posted ledger row", async () => {
      const { txn, created } = await earn(120, "order-reward:A");
      assert.equal(created, true);
      assert.equal(txn.type, "CREDIT");
      assert.equal(txn.status, "posted");
      assert.equal(txn.seq, 1);
      assert.equal(txn.availableBefore, 0);
      assert.equal(txn.availableAfter, 120);
      // Default expiry: 180 days for order rewards.
      assert.equal(txn.expiresAt.getTime(), at(180).getTime());

      const w = await balance(user);
      assert.equal(w.available, 120);
      assert.equal(w.totalEarned, 120);
      assert.equal(w.batches.length, 1);
      assert.equal(w.batches[0].remaining, 120);
      await assertReconciled(user);
    });

    it("never credits the same key twice, even concurrently", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => earn(50, "order-reward:dup")),
      );
      assert.equal(results.filter((r) => r.created).length, 1);
      assert.equal(new Set(results.map((r) => String(r.txn._id))).size, 1);
      assert.equal((await balance(user)).available, 50);
      assert.equal(await CoinTransaction.countDocuments({ user }), 1);
    });

    it("rejects zero, negative and fractional amounts", async () => {
      for (const coins of [0, -5, 1.5])
        await rejectsWith(earn(coins, `bad:${coins}`), "VALIDATION_ERROR");
      assert.equal(await CoinTransaction.countDocuments(), 0);
    });
  });

  describe("reserve, commit, release", () => {
    it("redeems coins: reserve then commit moves them to redeemed", async () => {
      await earn(300, "c1");
      await wallet.reserve(user, { coins: 100, key: "reserve:o1" }, { now: NOW });
      let w = await balance(user);
      assert.equal(w.available, 200);
      assert.equal(w.reserved, 100);

      await wallet.commitReservation(user, { reserveKey: "reserve:o1" });
      w = await balance(user);
      assert.equal(w.available, 200);
      assert.equal(w.reserved, 0);
      assert.equal(w.totalRedeemed, 100);

      // Repeating the commit is a no-op.
      const again = await wallet.commitReservation(user, { reserveKey: "reserve:o1" });
      assert.equal(again.created, false);
      assert.equal((await balance(user)).totalRedeemed, 100);
      await assertReconciled(user);
    });

    it("cannot reserve more than the balance, and writes nothing when it fails", async () => {
      await earn(80, "c1");
      await rejectsWith(wallet.reserve(user, { coins: 100, key: "reserve:big" }), "INSUFFICIENT_COINS");
      assert.equal(await CoinTransaction.countDocuments({ user }), 1);
      assert.equal((await balance(user)).available, 80);
    });

    it("releases a reservation (failed payment) back to the wallet exactly once", async () => {
      await earn(100, "c1");
      await wallet.reserve(user, { coins: 60, key: "reserve:o2" }, { now: NOW });
      await wallet.releaseReservation(user, { reserveKey: "reserve:o2" }, { now: NOW });
      await wallet.releaseReservation(user, { reserveKey: "reserve:o2" }, { now: NOW });
      const w = await balance(user);
      assert.equal(w.available, 100);
      assert.equal(w.reserved, 0);
      assert.equal(w.totalRedeemed, 0);
      await assertReconciled(user);
    });

    it("never both commits and releases the same reservation", async () => {
      await earn(100, "c1");
      await wallet.reserve(user, { coins: 40, key: "reserve:race" });
      const outcomes = await Promise.allSettled([
        wallet.commitReservation(user, { reserveKey: "reserve:race" }),
        wallet.releaseReservation(user, { reserveKey: "reserve:race" }),
        wallet.commitReservation(user, { reserveKey: "reserve:race" }),
        wallet.releaseReservation(user, { reserveKey: "reserve:race" }),
      ]);
      const closing = await CoinTransaction.find({ type: { $in: ["DEBIT", "RELEASE"] } });
      assert.equal(closing.length, 1, "exactly one closing row");
      for (const o of outcomes.filter((x) => x.status === "rejected"))
        assert.equal(o.reason.code, "RESERVATION_CLOSED");
      const w = await balance(user);
      assert.equal(w.reserved, 0);
      assert.equal(w.available + w.totalRedeemed, 100);
      await assertReconciled(user);
    });

    it("refunds coins spent on an order that was then cancelled", async () => {
      await earn(100, "c1");
      await wallet.reserve(user, { coins: 100, key: "reserve:o3" });
      await rejectsWith(wallet.refundRedemption(user, { reserveKey: "reserve:o3" }), "NOT_REDEEMED");
      await wallet.commitReservation(user, { reserveKey: "reserve:o3" });
      await wallet.refundRedemption(user, { reserveKey: "reserve:o3" });
      await wallet.refundRedemption(user, { reserveKey: "reserve:o3" });
      const w = await balance(user);
      assert.equal(w.available, 100);
      assert.equal(w.totalRedeemed, 0);
      await assertReconciled(user);
    });

    it("keeps the balance right under concurrent redemptions", async () => {
      await earn(100, "c1");
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          wallet.reserve(user, { coins: 30, key: `reserve:p${i}` }),
        ),
      );
      const ok = attempts.filter((a) => a.status === "fulfilled");
      assert.equal(ok.length, 3);
      for (const a of attempts.filter((x) => x.status === "rejected"))
        assert.equal(a.reason.code, "INSUFFICIENT_COINS");
      const w = await balance(user);
      assert.equal(w.available, 10);
      assert.equal(w.reserved, 90);
      await assertReconciled(user);
    });

    it("keeps the balance right under concurrent mixed operations", async () => {
      await earn(500, "seed");
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => earn(10, `mix-credit:${i}`)),
        ...Array.from({ length: 5 }, (_, i) =>
          wallet.reserve(user, { coins: 20, key: `mix-reserve:${i}` }),
        ),
      ]);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          i % 2
            ? wallet.commitReservation(user, { reserveKey: `mix-reserve:${i}` })
            : wallet.releaseReservation(user, { reserveKey: `mix-reserve:${i}` }),
        ),
      );
      const w = await balance(user);
      assert.equal(w.totalEarned, 550);
      assert.equal(w.totalRedeemed, 40);
      assert.equal(w.available, 510);
      assert.equal(w.reserved, 0);
      await assertReconciled(user);
    });
  });

  describe("FIFO and expiry", () => {
    it("spends the coins that expire first, and never-expiring coins last", async () => {
      await wallet.credit(user, { coins: 50, source: S.WELCOME_REWARD, key: "never", expiresAt: null }, { now: NOW });
      await wallet.credit(user, { coins: 30, source: S.ORDER_REWARD, key: "late", expiresAt: at(90) }, { now: NOW });
      await wallet.credit(user, { coins: 40, source: S.REVIEW_REWARD, key: "early", expiresAt: at(10) }, { now: NOW });

      const { txn } = await wallet.reserve(user, { coins: 60, key: "reserve:fifo" }, { now: NOW });
      assert.deepEqual(
        txn.allocations.map((a) => [a.source, a.coins]),
        [[S.REVIEW_REWARD, 40], [S.ORDER_REWARD, 20]],
      );
      const left = (await balance(user)).batches.map((b) => [b.source, b.remaining]);
      assert.deepEqual(left.sort(), [[S.ORDER_REWARD, 10], [S.WELCOME_REWARD, 50]].sort());
      await assertReconciled(user);
    });

    it("expires overdue batches once, and only what is left in them", async () => {
      await wallet.credit(user, { coins: 100, source: S.ORDER_REWARD, key: "old", expiresAt: at(5) }, { now: NOW });
      await wallet.credit(user, { coins: 70, source: S.ORDER_REWARD, key: "new", expiresAt: at(60) }, { now: NOW });
      // 30 of the expiring batch are spent first, so only 70 can expire.
      await wallet.reserve(user, { coins: 30, key: "reserve:e" }, { now: NOW });
      await wallet.commitReservation(user, { reserveKey: "reserve:e" });

      const first = await wallet.expireDueCoins({ now: at(6) });
      assert.deepEqual(first, { wallets: 1, batches: 1, coins: 70 });
      const second = await wallet.expireDueCoins({ now: at(6) });
      assert.deepEqual(second, { wallets: 0, batches: 0, coins: 0 });

      const w = await balance(user);
      assert.equal(w.available, 70);
      assert.equal(w.totalExpired, 70);
      assert.equal(w.totalRedeemed, 30);
      assert.equal(await CoinTransaction.countDocuments({ type: "EXPIRE" }), 1);
      await assertReconciled(user);
    });

    it("does not let customers spend coins that are past expiry but not yet swept", async () => {
      await wallet.credit(user, { coins: 100, source: S.ORDER_REWARD, key: "old", expiresAt: at(1) }, { now: NOW });
      await rejectsWith(
        wallet.reserve(user, { coins: 50, key: "reserve:late" }, { now: at(2) }),
        "INSUFFICIENT_COINS",
      );
      const summary = await wallet.walletSummary(user, { now: at(2) });
      assert.equal(summary.available, 0);
    });

    it("does not expire coins while expiry is switched off", async () => {
      await wallet.credit(user, { coins: 100, source: S.ORDER_REWARD, key: "old", expiresAt: at(1) }, { now: NOW });
      await updateRewardConfig(null, { expiry: { enabled: false } });
      assert.equal((await wallet.expireDueCoins({ now: at(3) })).coins, 0);
      await wallet.reserve(user, { coins: 100, key: "reserve:off" }, { now: at(3) });
      assert.equal((await balance(user)).reserved, 100);
    });

    it("gives released coins at least the grace period before they expire", async () => {
      await wallet.credit(user, { coins: 100, source: S.ORDER_REWARD, key: "c", expiresAt: at(2) }, { now: NOW });
      await wallet.reserve(user, { coins: 100, key: "reserve:g" }, { now: NOW });
      await wallet.releaseReservation(user, { reserveKey: "reserve:g" }, { now: at(1) });
      const [batch] = (await balance(user)).batches;
      assert.equal(batch.expiresAt.getTime(), at(1 + 7).getTime()); // restoreGraceDays = 7
      // A reserved coin did not expire while it was held.
      assert.equal((await wallet.expireDueCoins({ now: at(3) })).coins, 0);
      await assertReconciled(user);
    });

    it("assigns expiry per reward source from the configuration", async () => {
      await updateRewardConfig(null, { expiry: { days: { REVIEW_REWARD: 30, BIRTHDAY_REWARD: 0 } } });
      const review = await wallet.credit(user, { coins: 5, source: S.REVIEW_REWARD, key: "r" }, { now: NOW });
      const birthday = await wallet.credit(user, { coins: 100, source: S.BIRTHDAY_REWARD, key: "b" }, { now: NOW });
      assert.equal(review.txn.expiresAt.getTime(), at(30).getTime());
      assert.equal(birthday.txn.expiresAt, null);
    });
  });

  describe("reversals", () => {
    it("reverses part of a reward, then the rest, and never more than the reward", async () => {
      await earn(100, "order-reward:R");
      await wallet.reverseCredit(user, { creditKey: "order-reward:R", coins: 40, key: "rev:1" });
      await rejectsWith(
        wallet.reverseCredit(user, { creditKey: "order-reward:R", coins: 70, key: "rev:2" }),
        "REVERSAL_TOO_LARGE",
      );
      const rest = await wallet.reverseCredit(user, { creditKey: "order-reward:R", key: "rev:3" });
      assert.equal(rest.txn.coins, 60);
      await rejectsWith(
        wallet.reverseCredit(user, { creditKey: "order-reward:R", key: "rev:4" }),
        "ALREADY_REVERSED",
      );
      // Same key again: the original row, not a second reversal.
      const replay = await wallet.reverseCredit(user, { creditKey: "order-reward:R", coins: 40, key: "rev:1" });
      assert.equal(replay.created, false);
      const w = await balance(user);
      assert.equal(w.available, 0);
      assert.equal(w.totalReversed, 100);
      await assertReconciled(user);
    });

    it("records a shortfall instead of going negative when the coins were already spent", async () => {
      await earn(100, "order-reward:S");
      await wallet.reserve(user, { coins: 80, key: "reserve:s" });
      await wallet.commitReservation(user, { reserveKey: "reserve:s" });
      const { txn } = await wallet.reverseCredit(user, { creditKey: "order-reward:S", key: "rev:s" });
      assert.equal(txn.requestedCoins, 100);
      assert.equal(txn.coins, 20);
      assert.equal(txn.shortfall, 80);
      const w = await balance(user);
      assert.equal(w.available, 0);
      assert.equal(w.uncollectedReversal, 80);
      await assertReconciled(user);
    });

    it("takes reversed coins from the reversed reward's own batch first", async () => {
      await wallet.credit(user, { coins: 50, source: S.WELCOME_REWARD, key: "w", expiresAt: at(5) }, { now: NOW });
      await wallet.credit(user, { coins: 50, source: S.ORDER_REWARD, key: "order-reward:T", expiresAt: at(100) }, { now: NOW });
      const { txn } = await wallet.reverseCredit(user, { creditKey: "order-reward:T", coins: 30, key: "rev:t" });
      assert.deepEqual(txn.allocations.map((a) => a.source), [S.ORDER_REWARD]);
    });
  });

  describe("integrity", () => {
    it("recovers a row left pending by a crash before the wallet was updated", async () => {
      await earn(100, "c1");
      const crash = mock.method(CoinWallet, "updateOne", async () => {
        throw new Error("simulated crash");
      });
      await assert.rejects(earn(25, "c2"), /simulated crash/);
      crash.mock.restore();

      // The row exists but the wallet has not moved.
      assert.equal((await CoinTransaction.findOne({ idempotencyKey: "c2" })).status, "pending");
      assert.equal((await balance(user)).available, 100);

      // The next operation on the wallet finishes it first.
      await wallet.reserve(user, { coins: 125, key: "reserve:after-crash" });
      const w = await balance(user);
      assert.equal(w.available, 0);
      assert.equal(w.reserved, 125);
      // Retrying the crashed request returns its row, not a new credit.
      const retry = await earn(25, "c2");
      assert.equal(retry.created, false);
      assert.equal(retry.txn.status, "posted");
      await assertReconciled(user);
    });

    it("the sweep finishes pending rows nobody touched", async () => {
      await earn(10, "c1");
      const crash = mock.method(CoinWallet, "updateOne", async () => {
        throw new Error("simulated crash");
      });
      await assert.rejects(earn(15, "c2"), /simulated crash/);
      crash.mock.restore();
      assert.equal(await wallet.settlePendingRows({ now: new Date(Date.now() + 120_000) }), 1);
      assert.equal((await balance(user)).available, 25);
      await assertReconciled(user);
    });

    it("refuses to edit or delete ledger rows", async () => {
      const { txn } = await earn(10, "c1");
      await rejectsWith(CoinTransaction.updateOne({ _id: txn._id }, { $set: { coins: 9999 } }), "LEDGER_IMMUTABLE");
      await rejectsWith(CoinTransaction.findOneAndUpdate({ _id: txn._id }, { coins: 1 }), "LEDGER_IMMUTABLE");
      await rejectsWith(CoinTransaction.deleteOne({ _id: txn._id }), "LEDGER_IMMUTABLE");
      await rejectsWith(CoinTransaction.deleteMany({}), "LEDGER_IMMUTABLE");
      const doc = await CoinTransaction.findById(txn._id);
      doc.coins = 5000;
      await rejectsWith(doc.save(), "LEDGER_IMMUTABLE");
      await rejectsWith(doc.deleteOne(), "LEDGER_IMMUTABLE");
      assert.equal((await CoinTransaction.findById(txn._id)).coins, 10);
    });

    it("keeps one wallet per user and a gap-free sequence", async () => {
      await Promise.all(Array.from({ length: 6 }, (_, i) => earn(5, `par:${i}`)));
      assert.equal(await CoinWallet.countDocuments({ user }), 1);
      const seqs = (await CoinTransaction.find({ user }).sort({ seq: 1 })).map((r) => r.seq);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    });

    it("keeps wallets separate between customers", async () => {
      const other = newId();
      await earn(100, "mine");
      await wallet.credit(other, { coins: 5, source: S.ORDER_REWARD, key: "theirs" });
      await rejectsWith(wallet.reserve(other, { coins: 50, key: "reserve:other" }), "INSUFFICIENT_COINS");
      // Another customer cannot settle my reservation, even with my key.
      await wallet.reserve(user, { coins: 50, key: "reserve:mine" });
      await assert.rejects(wallet.commitReservation(other, { reserveKey: "reserve:mine" }), /not found/);
      // An idempotency key used by one wallet cannot be replayed by another.
      await assert.rejects(
        wallet.credit(other, { coins: 1, source: S.ORDER_REWARD, key: "mine" }),
        /belongs to another wallet/,
      );
      assert.equal((await wallet.listTransactions(other, {}, { skip: 0, limit: 10, page: 1 })).items.length, 1);
    });
  });

  // Runs only on a replica set (e.g. TEST_MONGO_URI on Atlas); standalone servers use the fallback path above.
  describe("inside MongoDB transactions", () => {
    it("rolls the ledger row and the wallet back together when the transaction aborts", async (t) => {
      if (!(await transactionsSupported())) return t.skip("standalone MongoDB: no transactions");
      await earn(100, "c1");
      await assert.rejects(
        withTransaction(async (session) => {
          await wallet.reserve(user, { coins: 60, key: "reserve:tx-abort" }, { session });
          throw new Error("order creation failed");
        }),
        /order creation failed/,
      );
      assert.equal(await CoinTransaction.countDocuments({ idempotencyKey: "reserve:tx-abort" }), 0);
      assert.equal((await balance(user)).available, 100);
      await assertReconciled(user);
    });

    it("keeps balances right when concurrent transactions reserve coins", async (t) => {
      if (!(await transactionsSupported())) return t.skip("standalone MongoDB: no transactions");
      await earn(100, "c1");
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          withTransaction((session) =>
            wallet.reserve(user, { coins: 30, key: `reserve:tx${i}` }, { session }),
          ),
        ),
      );
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 3);
      const w = await balance(user);
      assert.equal(w.available, 10);
      assert.equal(w.reserved, 90);
      await assertReconciled(user);
    });
  });

  describe("reading", () => {
    it("summarises balances, rupee value and upcoming expiry", async () => {
      await wallet.credit(user, { coins: 200, source: S.ORDER_REWARD, key: "a", expiresAt: at(10) }, { now: NOW });
      await wallet.credit(user, { coins: 1050, source: S.ORDER_REWARD, key: "b", expiresAt: at(100) }, { now: NOW });
      await wallet.reserve(user, { coins: 100, key: "reserve:r" }, { now: NOW });
      const s = await wallet.walletSummary(user, { now: NOW });
      assert.equal(s.available, 1150);
      assert.equal(s.reserved, 100);
      assert.equal(s.valuePaise, 11_500); // 100 coins = ₹10
      assert.equal(s.expiring.coins, 100); // 100 of the 10-day batch are left; the rest is beyond 30 days
      assert.equal(s.expiring.next.coins, 100);
      assert.equal(s.expiring.upcoming.length, 2);
    });

    it("lists the customer's ledger newest first without staff fields", async () => {
      await earn(100, "a");
      await wallet.reserve(user, { coins: 40, key: "reserve:l" });
      await wallet.reverseCredit(user, { creditKey: "a", coins: 10, key: "rev:l", note: "staff only" });
      const page = await wallet.listTransactions(user, {}, { skip: 0, limit: 10, page: 1 });
      assert.deepEqual(page.items.map((r) => r.type), ["REVERSAL", "RESERVE", "CREDIT"]);
      assert.equal(page.items[1].availableChange, -40);
      assert.equal(page.items[1].reservedChange, 40);
      assert.ok(!("note" in page.items[0]));
      assert.ok(!("createdBy" in page.items[0]));
      assert.equal(page.pagination.total, 3);
      const credits = await wallet.listTransactions(user, { type: "CREDIT" }, { skip: 0, limit: 10, page: 1 });
      assert.equal(credits.items.length, 1);
    });
  });
});
