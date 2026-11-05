import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { AuditLog } from "../models/audit-log.model.js";
import { CoinTransaction } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { Referral } from "../models/referral.model.js";
import * as wallet from "../services/coin-wallet.service.js";
import { buildApp, createAndLogin, PASSWORD, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";
import { orderWorld } from "./rewards-helpers.js";

const DAY = 86_400_000;

describe("coins & rewards administration", () => {
  let app;
  let w;
  let su; // super admin api
  let finance;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    w = await orderWorld(app);
    su = w.api(w.admin.token);
    finance = await createAndLogin(app, "finance_admin");
  });

  const me = () => w.customer.user.id;
  const audits = (action) => AuditLog.countDocuments({ action });

  describe("access", () => {
    it("is limited to the super admin", async () => {
      const urls = [
        "/api/v1/admin/rewards/configuration",
        "/api/v1/admin/rewards/campaigns",
        "/api/v1/admin/rewards/transactions",
        "/api/v1/admin/rewards/reports",
        "/api/v1/admin/rewards/referrals",
        `/api/v1/admin/rewards/wallets/${me()}`,
      ];
      for (const url of urls) {
        assert.equal((await su.get(url)).status, 200, url);
        for (const who of [w.customer, w.owner, w.rider, finance])
          assert.equal((await w.api(who.token).get(url)).status, 403, `${who.user.role} ${url}`);
      }
      const change = await w.api(w.customer.token).put("/api/v1/admin/rewards/configuration", { version: 0, coinsEnabled: false });
      assert.equal(change.status, 403);
    });
  });

  describe("configuration", () => {
    it("saves settings with a version check and an audit entry", async () => {
      const current = (await su.get("/api/v1/admin/rewards/configuration")).body.data.configuration;
      assert.equal(current.version, 0);
      const saved = await su.put("/api/v1/admin/rewards/configuration", {
        version: 0,
        redemption: { coinValueCoins: 50, coinValuePaise: 1000, minCoins: 50 },
        expiry: { days: { ORDER_REWARD: 90 } },
        referral: { referrerCoins: 75 },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const cfg = saved.body.data.configuration;
      assert.deepEqual([cfg.version, cfg.redemption.coinValueCoins, cfg.expiry.days.ORDER_REWARD, cfg.referral.referrerCoins], [1, 50, 90, 75]);
      assert.equal(await audits("rewards.configure"), 1);

      const stale = await su.put("/api/v1/admin/rewards/configuration", { version: 0, birthday: { coins: 1 } });
      assert.equal(stale.status, 409);
      const bad = await su.put("/api/v1/admin/rewards/configuration", { version: 1, redemption: { maxPercentOfOrder: 500 } });
      assert.equal(bad.status, 422);
      const noVersion = await su.put("/api/v1/admin/rewards/configuration", { birthday: { coins: 1 } });
      assert.equal(noVersion.status, 422);

      // The new conversion is used at once: 100 coins are now worth ₹20.
      const res = await w.api(w.customer.token).get("/api/v1/coins/wallet");
      assert.equal(res.body.data.rules.coinValueCoins, 50);
    });

    it("stops earning and redeeming when coins are switched off", async () => {
      await su.put("/api/v1/admin/rewards/configuration", { version: 0, coinsEnabled: false });
      await wallet.credit(me(), { coins: 500, source: "PROMOTIONAL_REWARD", key: "gift" });
      await w.fillCart();
      assert.equal((await w.api(w.customer.token).put("/api/v1/cart/coins", { coins: 200 })).status, 422);
      const { order } = await w.place("cod");
      await w.deliver(order.id);
      assert.equal(await CoinTransaction.countDocuments({ source: "ORDER_REWARD" }), 0);
    });
  });

  describe("campaigns", () => {
    it("creates, schedules, edits and reports on a campaign", async () => {
      const now = Date.now();
      const created = await su.post("/api/v1/admin/rewards/campaigns", {
        name: "New Year cheer",
        type: "FESTIVAL",
        rewardCoins: 60,
        startAt: new Date(now - 1000).toISOString(),
        endAt: new Date(now + 2 * DAY).toISOString(),
        limits: { maxTotalClaims: 100, maxTotalCoins: null },
        unexpected: "dropped",
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.campaign.id;
      assert.equal(created.body.data.campaign.status, "DRAFT");

      const active = await su.patch(`/api/v1/admin/rewards/campaigns/${id}/status`, { action: "activate" });
      assert.equal(active.body.data.campaign.status, "ACTIVE");
      const claim = await w.api(w.customer.token).post(`/api/v1/rewards/campaigns/${id}/claim`);
      assert.equal(claim.status, 201);

      const edit = await su.put(`/api/v1/admin/rewards/campaigns/${id}`, { rewardCoins: 600 });
      assert.equal(edit.status, 409, "the reward cannot change while running");
      await su.patch(`/api/v1/admin/rewards/campaigns/${id}/status`, { action: "pause" });
      assert.equal((await su.put(`/api/v1/admin/rewards/campaigns/${id}`, { rewardCoins: 80 })).status, 200);

      const detail = (await su.get(`/api/v1/admin/rewards/campaigns/${id}`)).body.data;
      assert.equal(detail.performance.claims, 1);
      assert.equal(detail.recentClaims[0].coins, 60);
      const claims = (await su.get("/api/v1/admin/rewards/claims?rewardType=FESTIVAL")).body.data;
      assert.equal(claims.items.length, 1);
      assert.equal(await audits("rewards.campaign.create"), 1);
      assert.equal(await audits("rewards.campaign.status"), 2);
      assert.equal((await su.post("/api/v1/admin/rewards/campaigns", { name: "x" })).status, 422);
    });
  });

  describe("ledger", () => {
    it("lists every customer's transactions with filters", async () => {
      await wallet.credit(me(), { coins: 100, source: "PROMOTIONAL_REWARD", key: "a" });
      await wallet.reserve(me(), { coins: 40, key: "r" });
      const all = (await su.get("/api/v1/admin/rewards/transactions")).body.data;
      assert.equal(all.items.length, 2);
      assert.equal(all.items[0].customer.email, "customer@bitebox.test");
      const credits = (await su.get("/api/v1/admin/rewards/transactions?type=CREDIT&search=customer@bitebox")).body.data;
      assert.equal(credits.items.length, 1);
      const one = (await su.get(`/api/v1/admin/rewards/transactions/${credits.items[0].id}`)).body.data;
      assert.equal(one.transaction.coins, 100);
    });

    it("reverses a reward partially, once per request, with an audit trail", async () => {
      const { txn } = await wallet.credit(me(), { coins: 100, source: "ORDER_REWARD", key: "order-reward:x" });
      const reverse = (key, payload) =>
        request(app)
          .post(`/api/v1/admin/rewards/transactions/${txn.id}/reverse`)
          .set({ Authorization: `Bearer ${w.admin.token}`, "Idempotency-Key": key })
          .send(payload);
      assert.equal((await su.post(`/api/v1/admin/rewards/transactions/${txn.id}/reverse`, { reason: "Refund" })).status, 422, "needs an idempotency key");

      const first = await reverse("reverse-key-0001", { coins: 30, reason: "Partial refund of order" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const repeat = await reverse("reverse-key-0001", { coins: 30, reason: "Partial refund of order" });
      assert.equal(repeat.status, 200);
      assert.equal((await CoinWallet.findOne({ user: me() })).available, 70, "the repeat did nothing");
      const tooMuch = await reverse("reverse-key-0002", { coins: 80, reason: "Too much" });
      assert.equal(tooMuch.status, 409);
      const rest = await reverse("reverse-key-0003", { reason: "Fraud" });
      assert.equal(rest.body.data.transaction.coins, 70);
      assert.equal((await CoinWallet.findOne({ user: me() })).available, 0);
      assert.equal(await audits("rewards.reverse"), 3);

      const reversalRow = await CoinTransaction.findOne({ type: "REVERSAL" }).sort({ seq: 1 });
      assert.equal(reversalRow.note, "Partial refund of order");
      assert.equal(String(reversalRow.createdBy), w.admin.user.id);
      // Debits cannot be "reversed" from here.
      await wallet.credit(me(), { coins: 200, source: "PROMOTIONAL_REWARD", key: "g" });
      const { txn: hold } = await wallet.reserve(me(), { coins: 100, key: "h" });
      const notAReward = await request(app)
        .post(`/api/v1/admin/rewards/transactions/${hold.id}/reverse`)
        .set({ Authorization: `Bearer ${w.admin.token}`, "Idempotency-Key": "reverse-key-0005" })
        .send({ reason: "Not a reward" });
      assert.equal(notAReward.status, 409);

      const detail = (await su.get(`/api/v1/admin/rewards/wallets/${me()}`)).body.data;
      assert.equal(detail.integrity.ok, true);
      assert.equal(detail.wallet.reserved, 100);
    });
  });

  describe("reports and referrals", () => {
    it("reports issued, redeemed, liability and suspicious activity", async () => {
      await wallet.credit(me(), { coins: 300, source: "REFERRAL_REWARD", key: "ref" });
      await wallet.credit(me(), { coins: 200, source: "FESTIVAL_REWARD", key: "fest" });
      await wallet.reserve(me(), { coins: 100, key: "res" });
      await wallet.commitReservation(me(), { reserveKey: "res" });
      await wallet.reverseCredit(me(), { creditKey: "fest", coins: 50, key: "rev" });
      const r = (await su.get("/api/v1/admin/rewards/reports?days=7")).body.data;
      assert.equal(r.allTime.issued, 500);
      assert.equal(r.allTime.netRedeemed, 100);
      assert.equal(r.allTime.reversed, 50);
      assert.equal(r.allTime.referralRewards, 300);
      assert.equal(r.allTime.promotionalRewards, 200);
      assert.equal(r.liability.coins, 350);
      assert.equal(r.liability.paise, 3500);
      assert.equal(r.wallets.active, 1);
      assert.equal(r.daily.length, 7);
      assert.equal(r.daily.at(-1).issued, 500);
      assert.equal(r.suspicious.topEarners[0].coins, 500);
    });

    it("lets the super admin review and approve held referrals", async () => {
      const code = (await w.api(w.customer.token).get("/api/v1/referrals/me")).body.data.code;
      const res = await request(app).post("/api/v1/auth/register").send({
        name: "Kabir Shah",
        email: `kabir-${Date.now()}@example.com`,
        password: PASSWORD,
        referralCode: code,
      });
      const friend = { token: res.body.data.accessToken, user: res.body.data.user };
      await w.fillCart({ token: friend.token });
      const { order } = await w.place("cod", { token: friend.token, userId: friend.user.id });
      await w.deliver(order.id); // same IP as the referrer: held

      const held = (await su.get("/api/v1/admin/rewards/referrals?rewardStatus=HELD")).body.data;
      assert.equal(held.items.length, 1);
      assert.ok(held.items[0].riskFlags.includes("SAME_SIGNUP_IP"));
      assert.equal(held.items[0].referrer.email, "customer@bitebox.test");
      const id = held.items[0].id;
      assert.equal((await su.post(`/api/v1/admin/rewards/referrals/${id}/reject`, {})).status, 422, "rejecting needs a note");
      const approved = await su.post(`/api/v1/admin/rewards/referrals/${id}/approve`, { note: "Flatmates, verified" });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal((await Referral.findById(id)).status, "REWARD_CREDITED");
      assert.equal(await audits("rewards.referral.approve"), 1);
    });
  });
});
