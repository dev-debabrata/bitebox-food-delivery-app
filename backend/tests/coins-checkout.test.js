import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DISPATCH } from "../config/dispatch.js";
import { COIN_SOURCES } from "../config/rewards.js";
import { CoinTransaction } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { Notification } from "../models/notification.model.js";
import { Order, Payment } from "../models/order.model.js";
import * as wallet from "../services/coin-wallet.service.js";
import { orderRewardCoins, redemptionQuote } from "../services/coins.service.js";
import { sweep } from "../services/dispatch.service.js";
import { getRewardConfig, updateRewardConfig } from "../services/reward-config.service.js";
import { rewardsSweep } from "../services/rewards-jobs.service.js";
import { buildApp, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";
import { orderWorld } from "./rewards-helpers.js";

const S = COIN_SOURCES;

describe("coins at checkout and order rewards", () => {
  let app;
  let w; // the order world

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    w = await orderWorld(app);
  });

  const me = () => w.customer.user.id;
  const balance = () => CoinWallet.findOne({ user: me() }).lean();
  const gift = (coins, key = "gift") =>
    wallet.credit(me(), { coins, source: S.PROMOTIONAL_REWARD, key });
  const customerApi = () => w.api(w.customer.token);
  async function reconciled() {
    const r = await wallet.reconcile(me());
    assert.deepEqual(r.issues, []);
  }

  describe("earning", () => {
    it("credits coins once for a delivered order, on the food value only", async () => {
      await w.fillCart();
      const { order } = await w.place("cod");
      await w.deliver(order.id);

      // ₹698 food value -> 6 x ₹100 -> 60 coins (fees and tax are not counted).
      const saved = await Order.findById(order.id);
      assert.equal(saved.coins.earned, 60);
      assert.equal((await balance()).available, 60);
      assert.equal(await Notification.countDocuments({ user: me(), type: "coins.earned" }), 1);

      // Repeating the delivery follow-up does not pay again.
      const { rewardDeliveredOrder } = await import("../services/coins.service.js");
      await rewardDeliveredOrder(saved);
      assert.equal((await balance()).available, 60);
      assert.equal(await CoinTransaction.countDocuments({ source: S.ORDER_REWARD }), 1);
    });

    it("gives nothing for cancelled or rejected orders", async () => {
      await w.fillCart();
      const { order } = await w.place("cod");
      assert.equal((await w.reject(order.id)).status, 200);
      assert.equal(await CoinTransaction.countDocuments({ user: me() }), 0);
    });

    it("follows the configured earning rule and switches", async () => {
      const config = await getRewardConfig();
      const order = { pricing: { subtotalPaise: 69_800, discountPaise: 9_800, coinDiscountPaise: 1_000 } };
      assert.equal(orderRewardCoins(order, config), 50); // ₹590 -> 5 x 10
      assert.equal(orderRewardCoins(order, { ...config, earning: { ...config.earning, order: { ...config.earning.order, maxCoinsPerOrder: 30 } } }), 30);
      assert.equal(orderRewardCoins(order, { ...config, coinsEnabled: false }), 0);
      assert.equal(orderRewardCoins(order, { ...config, earning: { ...config.earning, order: { ...config.earning.order, minOrderPaise: 60_000 } } }), 0);
    });

    it("pays the review bonus once per delivered order and takes it back if the review is deleted", async () => {
      await w.fillCart();
      const { order } = await w.place("cod");
      await w.deliver(order.id);
      const review = await customerApi().post(`/api/v1/orders/${order.id}/reviews`, {
        restaurant: 5,
        comment: "Lovely food, arrived hot.",
      });
      assert.equal(review.status, 201, JSON.stringify(review.body));
      assert.equal((await balance()).available, 65);

      // A second review attempt for the same order is refused and pays nothing.
      const again = await customerApi().post(`/api/v1/orders/${order.id}/reviews`, { restaurant: 4 });
      assert.equal(again.status, 409);
      // Rating the rider later is not a second restaurant review either.
      await customerApi().post(`/api/v1/orders/${order.id}/reviews`, { rider: 5 });
      assert.equal((await balance()).available, 65);

      const mine = await customerApi().get(`/api/v1/orders/${order.id}/reviews`);
      const reviewId = mine.body.data.restaurant.review?.id;
      assert.ok(reviewId, JSON.stringify(mine.body.data).slice(0, 300));
      const del = await customerApi().del(`/api/v1/reviews/${reviewId}`);
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal((await balance()).available, 60);
      assert.equal((await balance()).totalReversed, 5);
      await reconciled();
    });

    it("can require a written comment for the review bonus", async () => {
      await updateRewardConfig(null, { earning: { review: { minCommentLength: 20 } } });
      await w.fillCart();
      const { order } = await w.place("cod");
      await w.deliver(order.id);
      await customerApi().post(`/api/v1/orders/${order.id}/reviews`, { restaurant: 5, comment: "Nice" });
      assert.equal(await CoinTransaction.countDocuments({ source: S.REVIEW_REWARD }), 0);
    });
  });

  describe("redeeming", () => {
    it("works out the redeemable amount on the server", async () => {
      const config = await getRewardConfig();
      const q = (available, requested, foodPaise = 69_800) =>
        redemptionQuote({ config, available, requested, foodPaise });
      assert.equal(q(5000, 0).maxRedeemable, 1396); // 20% of ₹698 = ₹139.60 = 1396 coins
      assert.equal(q(500, 0).maxRedeemable, 500);
      assert.equal(q(50, 0).maxRedeemable, 0); // below the 100-coin minimum
      assert.deepEqual([q(500, 200).applied, q(500, 200).discountPaise], [200, 2000]);
      assert.equal(q(500, 900).applied, 500);
      assert.equal(q(500, 50).applied, 0);
      assert.equal(q(500, 200, 10_000).applied, 0); // order below ₹199
      assert.equal(redemptionQuote({ config: { ...config, coinsEnabled: false }, available: 500, requested: 200, foodPaise: 69_800 }).applied, 0);
    });

    it("redeems coins on a cash order: lower total, coins spent at once", async () => {
      await gift(500);
      const before = await w.fillCart();
      const res = await customerApi().put("/api/v1/cart/coins", { coins: 200 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const quote = res.body.data;
      assert.equal(quote.coins.applied, 200);
      assert.equal(quote.pricing.coinDiscountPaise, 2000); // 100 coins = ₹10
      assert.equal(quote.pricing.totalPaise, before.pricing.totalPaise - 2000);

      const { order } = await w.place("cod", { body: { expectedTotalPaise: quote.pricing.totalPaise } });
      assert.equal(order.pricing.coinDiscountPaise, 2000);
      assert.equal(order.coins.redeemed, 200);
      assert.equal(order.coins.state, "committed");
      assert.equal((await Payment.findOne({ order: order.id })).amountPaise, quote.pricing.totalPaise);
      const b = await balance();
      assert.deepEqual([b.available, b.reserved, b.totalRedeemed], [300, 0, 200]);

      // Earning is measured after the coin discount: ₹678 -> 60 coins.
      await w.deliver(order.id);
      assert.equal((await Order.findById(order.id)).coins.earned, 60);
      await reconciled();
    });

    it("holds coins for an online order, spends them when paid and refunds them if it is rejected", async () => {
      await gift(500);
      await w.fillCart();
      await customerApi().put("/api/v1/cart/coins", { coins: 300 });
      const { order } = await w.place("online");
      assert.equal(order.coins.state, "reserved");
      let b = await balance();
      assert.deepEqual([b.available, b.reserved], [200, 300]);

      // A failed attempt keeps the hold so the customer can retry.
      await w.mockPay(order.id, "failure");
      assert.equal((await balance()).reserved, 300);
      await w.mockPay(order.id, "success");
      b = await balance();
      assert.deepEqual([b.available, b.reserved, b.totalRedeemed], [200, 0, 300]);
      assert.equal((await Order.findById(order.id)).coins.state, "committed");

      await w.reject(order.id);
      b = await balance();
      assert.deepEqual([b.available, b.totalRedeemed], [500, 0]);
      assert.equal((await Order.findById(order.id)).coins.state, "refunded");
      assert.equal(await Notification.countDocuments({ user: me(), type: "coins.returned" }), 1);
      await reconciled();
    });

    it("releases held coins when the payment window expires", async () => {
      await gift(500);
      await w.fillCart();
      await customerApi().put("/api/v1/cart/coins", { coins: 150 });
      const { order } = await w.place("online");
      await sweep(new Date(Date.now() + (DISPATCH.paymentWindowMinutes + 1) * 60_000));
      const b = await balance();
      assert.deepEqual([b.available, b.reserved], [500, 0]);
      assert.equal((await Order.findById(order.id)).coins.state, "released");
      await reconciled();
    });

    it("gives the coins back and asks for them again when the payment page is abandoned", async () => {
      await gift(500);
      await w.fillCart();
      await customerApi().put("/api/v1/cart/coins", { coins: 150 });
      const { order } = await w.place("online");
      await customerApi().post(`/api/v1/payments/orders/${order.id}/abandon`);
      assert.equal((await balance()).available, 500);
      const cart = await customerApi().get("/api/v1/cart");
      assert.equal(cart.body.data.coins.applied, 150);
    });

    it("validates the amount and the payment method", async () => {
      await gift(500);
      await w.fillCart();
      const small = await customerApi().put("/api/v1/cart/coins", { coins: 50 });
      assert.equal(small.status, 422);
      assert.equal(small.body.error.code, "COINS_BELOW_MINIMUM");
      assert.equal((await customerApi().put("/api/v1/cart/coins", { coins: -5 })).status, 422);
      assert.equal((await customerApi().put("/api/v1/cart/coins", { coins: "lots" })).status, 422);
      // More than the balance is clamped to what can be used.
      const big = await customerApi().put("/api/v1/cart/coins", { coins: 5000 });
      assert.equal(big.body.data.coins.applied, 500);

      await updateRewardConfig(null, { redemption: { paymentMethods: ["online"] } });
      const res = await w.place("cod", { expectStatus: 409 });
      assert.equal(res.error.code, "COINS_NOT_ALLOWED");
      assert.equal(await Order.countDocuments(), 0);
      assert.equal((await balance()).available, 500, "nothing held after a refused order");
    });

    it("refuses an order when the balance dropped after the quote", async () => {
      await gift(500, "gift-a");
      await w.fillCart();
      const quote = (await customerApi().put("/api/v1/cart/coins", { coins: 400 })).body.data;
      await wallet.reverseCredit(me(), { creditKey: "gift-a", coins: 300, key: "rev:test" });
      const res = await w.place("cod", { expectStatus: 409, body: { expectedTotalPaise: quote.pricing.totalPaise } });
      assert.match(JSON.stringify(res), /PRICE_CHANGED/);
      assert.equal((await balance()).available, 200);
    });

    it("cannot redeem below the minimum balance and shows why", async () => {
      await gift(60);
      await w.fillCart();
      const res = await customerApi().put("/api/v1/cart/coins", { coins: 60 });
      assert.equal(res.status, 422);
      const cart = await customerApi().get("/api/v1/cart");
      assert.equal(cart.body.data.coins.maxRedeemable, 0);
      assert.match(cart.body.data.coins.message, /at least 100 coins/);
    });

    it("removes coins from the cart", async () => {
      await gift(500);
      await w.fillCart();
      await customerApi().put("/api/v1/cart/coins", { coins: 200 });
      const res = await customerApi().del("/api/v1/cart/coins");
      assert.equal(res.body.data.coins.applied, 0);
      assert.equal(res.body.data.pricing.coinDiscountPaise, 0);
    });
  });

  describe("wallet API and security", () => {
    it("shows the customer's own wallet and history only", async () => {
      await gift(250);
      const res = await customerApi().get("/api/v1/coins/wallet");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.wallet.available, 250);
      assert.equal(res.body.data.wallet.valuePaise, 2500);
      assert.equal(res.body.data.rules.minCoins, 100);
      const txns = await customerApi().get("/api/v1/coins/transactions?type=CREDIT");
      assert.equal(txns.body.data.items.length, 1);
      assert.equal(txns.body.data.items[0].availableChange, 250);
    });

    it("has no way for a client to change a balance", async () => {
      for (const [method, url] of [
        ["post", "/api/v1/coins/wallet"],
        ["put", "/api/v1/coins/wallet"],
        ["patch", "/api/v1/coins/wallet"],
        ["post", "/api/v1/coins/transactions"],
      ]) {
        const res = await customerApi()[method === "patch" ? "patch" : method](url, { available: 99_999 });
        assert.equal(res.status, 404, `${method} ${url}`);
      }
      assert.equal(await CoinWallet.countDocuments({ available: 99_999 }), 0);
    });

    it("keeps wallets to customers", async () => {
      for (const who of [w.admin, w.owner, w.rider]) {
        const res = await w.api(who.token).get("/api/v1/coins/wallet");
        assert.equal(res.status, 403);
      }
      const anon = await w.api("").get("/api/v1/coins/wallet");
      assert.equal(anon.status, 401);
    });
  });

  describe("rewards sweep", () => {
    it("settles coin holds the workflow left open and expires coins", async () => {
      await gift(500);
      await w.fillCart();
      await customerApi().put("/api/v1/cart/coins", { coins: 100 });
      const { order } = await w.place("online");
      // Simulate a crash after the cancellation but before the coin follow-up ran.
      await Order.updateOne({ _id: order.id }, { $set: { status: "cancelled" } });
      const summary = await rewardsSweep(new Date());
      assert.equal(summary.coinHolds.returned, 1);
      assert.equal((await balance()).available, 500);

      const later = await rewardsSweep(new Date(Date.now() + 200 * 86_400_000));
      assert.equal(later.expiredCoins.coins, 500);
      assert.equal((await balance()).available, 0);
      await reconciled();
    });
  });
});
