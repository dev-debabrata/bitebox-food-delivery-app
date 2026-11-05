import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { CoinTransaction } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { Referral } from "../models/referral.model.js";
import { User } from "../models/user.model.js";
import * as referrals from "../services/referral.service.js";
import { updateRewardConfig } from "../services/reward-config.service.js";
import { rewardsSweep } from "../services/rewards-jobs.service.js";
import { buildApp, PASSWORD, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";
import { orderWorld } from "./rewards-helpers.js";

const DAY = 86_400_000;
// The seeded customer (the referrer) lives here; friends order to a different place by default.
const REFERRER_HOME = [77.6271, 12.9352];

describe("referrals", () => {
  let app;
  let w;
  let code;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    w = await orderWorld(app);
    code = (await w.api(w.customer.token).get("/api/v1/referrals/me")).body.data.code;
  });

  let n = 0;
  async function signUp(referralCode, overrides = {}) {
    n++;
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: `Asha Rao${n}`.replace(/\d/g, ""),
        email: `friend${n}-${Date.now()}@example.com`,
        password: PASSWORD,
        ...(referralCode !== undefined && { referralCode }),
        ...overrides,
      });
    return { res, token: res.body.data?.accessToken, user: res.body.data?.user };
  }
  // Tests run from one machine, so every account shares an IP; clear it unless a test checks it.
  const forgetIps = () => Referral.updateMany({}, { $unset: { signupIp: 1 } });
  const coinsOf = async (userId) => (await CoinWallet.findOne({ user: userId }).lean())?.available ?? 0;

  async function friendOrders(friend, { coordinates, quantity = 2, deliver = true } = {}) {
    await w.fillCart({ token: friend.token, quantity });
    const { order } = await w.place("cod", { token: friend.token, userId: friend.user.id, coordinates });
    if (deliver) await w.deliver(order.id);
    return order;
  }

  describe("codes", () => {
    it("gives every customer one unique code, and none to partners", async () => {
      assert.match(code, /^BITEBOX-[A-Z]{1,5}[A-Z2-9]{4}$/);
      const again = (await w.api(w.customer.token).get("/api/v1/referrals/me")).body.data;
      assert.equal(again.code, code);
      assert.match(again.link, new RegExp(`/register\\?ref=${code}$`));

      const friend = await signUp();
      const friendCode = (await User.findById(friend.user.id)).referralCode;
      assert.ok(friendCode && friendCode !== code);

      const partner = await signUp(undefined, { role: "restaurant" });
      assert.equal((await User.findById(partner.user.id)).referralCode, undefined);
      assert.equal((await w.api(partner.token).get("/api/v1/referrals/me")).status, 403);
    });

    it("generates readable codes and retries on a clash", async () => {
      assert.match(referrals.generateCode("Élodie Fernandes"), /^BITEBOX-ELODI[A-Z2-9]{4}$/);
      assert.match(referrals.generateCode("  "), /^BITEBOX-FRIEND[A-Z2-9]{4}$/);
      const codes = new Set(Array.from({ length: 200 }, () => referrals.generateCode("Asha")));
      assert.ok(codes.size > 190);
    });

    it("validates a code publicly without revealing whose it is", async () => {
      const ok = await request(app).post("/api/v1/referrals/validate").send({ code: code.toLowerCase() });
      assert.deepEqual(ok.body.data, { valid: true });
      const bad = await request(app).post("/api/v1/referrals/validate").send({ code: "BITEBOX-NOPE1234" });
      assert.equal(bad.body.data.valid, false);
      assert.ok(!JSON.stringify(ok.body).includes(w.customer.user.name));
    });
  });

  describe("sign-up", () => {
    it("records the relationship when a friend signs up with a code", async () => {
      const friend = await signUp(code);
      assert.equal(friend.res.status, 201, JSON.stringify(friend.res.body));
      const referral = await Referral.findOne({ referred: friend.user.id });
      assert.equal(referral.status, "REGISTERED");
      assert.equal(String(referral.referrer), w.customer.user.id);
      assert.ok(referral.attributionExpiresAt > new Date(Date.now() + 29 * DAY));
    });

    it("rejects an unknown or unusable code without creating the account", async () => {
      const email = `nobody-${Date.now()}@example.com`;
      const res = (await signUp("BITEBOX-NOPE1234", { email })).res;
      assert.equal(res.status, 422);
      assert.equal(res.body.error.details[0].field, "referralCode");
      assert.equal(await User.countDocuments({ email }), 0);

      // A partner's account cannot refer customers even if it somehow had a code.
      await User.updateOne({ email: "restaurant@bitebox.test" }, { $set: { referralCode: "BITEBOX-SHOP2345" } });
      assert.equal((await signUp("BITEBOX-SHOP2345")).res.status, 422);
    });

    it("refuses self-referral and a second referrer", async () => {
      const me = await User.findById(w.customer.user.id);
      await assert.rejects(referrals.recordSignup(me, { referrer: me, code }), /own code/);

      const friend = await signUp(code);
      const other = await signUp();
      const otherCode = (await User.findById(other.user.id)).referralCode;
      const friendUser = await User.findById(friend.user.id);
      const second = await referrals.recordSignup(friendUser, { referrer: await User.findById(other.user.id), code: otherCode });
      assert.equal(String(second.referrer), w.customer.user.id, "still the first referrer");
      assert.equal(await Referral.countDocuments({ referred: friend.user.id }), 1);
    });

    it("enforces the maximum number of referrals per customer", async () => {
      await updateRewardConfig(null, { referral: { maxReferralsPerCustomer: 1 } });
      assert.equal((await signUp(code)).res.status, 201);
      const res = (await signUp(code)).res;
      assert.equal(res.status, 422);
      assert.match(res.body.message, /no longer be used/);
    });

    it("accepts no codes while referrals are switched off", async () => {
      await updateRewardConfig(null, { referral: { enabled: false } });
      assert.equal((await signUp(code)).res.status, 422);
      assert.equal((await signUp()).res.status, 201, "sign-up without a code still works");
    });
  });

  describe("rewards", () => {
    it("rewards both sides only after the friend's first order is delivered, once", async () => {
      const friend = await signUp(code);
      await forgetIps();
      const order = await friendOrders(friend, { deliver: false });
      let referral = await Referral.findOne({ referred: friend.user.id });
      assert.equal(referral.status, "FIRST_ORDER_PLACED");
      assert.equal(String(referral.qualifyingOrder), order.id);
      assert.equal(await coinsOf(w.customer.user.id), 0, "nothing before delivery");

      await w.deliver(order.id);
      referral = await Referral.findOne({ referred: friend.user.id });
      assert.equal(referral.status, "REWARD_CREDITED");
      assert.equal(referral.rewardStatus, "CREDITED");
      assert.deepEqual([referral.referrerCoins, referral.referredCoins], [50, 25]);
      assert.equal(await coinsOf(w.customer.user.id), 50);
      assert.equal(await coinsOf(friend.user.id), 25 + 60 + 25); // referral bonus + order reward + welcome bonus

      // A second delivered order pays no further referral rewards.
      await friendOrders(friend);
      assert.equal(await CoinTransaction.countDocuments({ source: "REFERRAL_REWARD" }), 2);

      const mine = (await w.api(w.customer.token).get("/api/v1/referrals/me")).body.data;
      assert.equal(mine.stats.successful, 1);
      assert.equal(mine.stats.coinsEarned, 50);
      const history = (await w.api(w.customer.token).get("/api/v1/referrals/me/history")).body.data;
      assert.equal(history.items[0].friend, "Asha R.");
      assert.ok(!JSON.stringify(history).includes("@example.com"), "no emails");
      const theirs = (await w.api(friend.token).get("/api/v1/referrals/me")).body.data;
      assert.equal(theirs.referredBy.coins, 25);
    });

    it("waits again if the first order is cancelled, and ignores orders below the minimum", async () => {
      const friend = await signUp(code);
      await forgetIps();
      const first = await friendOrders(friend, { deliver: false });
      await w.reject(first.id);
      assert.equal((await Referral.findOne({ referred: friend.user.id })).status, "REGISTERED");

      await updateRewardConfig(null, { referral: { minOrderPaise: 100_000 } });
      await friendOrders(friend); // ₹698 < ₹1000
      assert.equal((await Referral.findOne({ referred: friend.user.id })).status, "REGISTERED");
      assert.equal(await CoinTransaction.countDocuments({ source: "REFERRAL_REWARD" }), 0);
    });

    it("expires referrals with no qualifying order in time", async () => {
      const friend = await signUp(code);
      await rewardsSweep(new Date(Date.now() + 31 * DAY));
      assert.equal((await Referral.findOne({ referred: friend.user.id })).status, "EXPIRED");
      await friendOrders(friend);
      assert.equal(await CoinTransaction.countDocuments({ source: "REFERRAL_REWARD" }), 0);
    });

    it("does not reward an order placed after the window closed", async () => {
      const friend = await signUp(code);
      await forgetIps();
      await Referral.updateOne({ referred: friend.user.id }, { attributionExpiresAt: new Date(Date.now() - 1000) });
      await friendOrders(friend);
      const referral = await Referral.findOne({ referred: friend.user.id });
      assert.equal(referral.status, "EXPIRED");
      assert.equal(await coinsOf(w.customer.user.id), 0);
    });

    it("pays the friend but not the referrer beyond the monthly limit", async () => {
      await updateRewardConfig(null, { referral: { maxRewardsPerMonth: 1 } });
      const a = await signUp(code);
      const b = await signUp(code);
      await forgetIps();
      await friendOrders(a);
      await friendOrders(b, { coordinates: [77.65, 12.98] });
      const second = await Referral.findOne({ referred: b.user.id });
      assert.equal(second.rewardStatus, "PARTIAL");
      assert.equal(second.referrerCoins, 0);
      assert.equal(second.referredCoins, 25);
      assert.equal(await coinsOf(w.customer.user.id), 50);
    });

    it("holds suspicious referrals for an admin, who can approve or reject them", async () => {
      const friend = await signUp(code); // same IP as the referrer's sessions
      await friendOrders(friend, { coordinates: REFERRER_HOME });
      let referral = await Referral.findOne({ referred: friend.user.id });
      assert.equal(referral.status, "ORDER_DELIVERED");
      assert.equal(referral.rewardStatus, "HELD");
      assert.ok(referral.riskFlags.includes("SAME_SIGNUP_IP"));
      assert.ok(referral.riskFlags.includes("ADDRESS_MATCHES_REFERRER"));
      assert.equal(await coinsOf(w.customer.user.id), 0);

      // Customers never see the risk signals.
      const seen = JSON.stringify((await w.api(w.customer.token).get("/api/v1/referrals/me/history")).body);
      assert.ok(!seen.includes("SAME_SIGNUP_IP") && !seen.includes("riskFlags"));

      const admin = await User.findById(w.admin.user.id);
      await referrals.approve(admin, referral.id, "Checked: siblings in one flat");
      referral = await Referral.findById(referral.id);
      assert.equal(referral.status, "REWARD_CREDITED");
      assert.equal(await coinsOf(w.customer.user.id), 50);
      await assert.rejects(referrals.approve(admin, referral.id), /held for review/);
    });

    it("rejecting a held referral pays nothing", async () => {
      const friend = await signUp(code);
      await friendOrders(friend, { coordinates: REFERRER_HOME });
      const referral = await Referral.findOne({ referred: friend.user.id });
      await referrals.reject(await User.findById(w.admin.user.id), referral.id, "Same household");
      assert.equal((await Referral.findById(referral.id)).status, "REJECTED");
      assert.equal(await CoinTransaction.countDocuments({ source: "REFERRAL_REWARD" }), 0);
      const history = (await w.api(w.customer.token).get("/api/v1/referrals/me/history")).body.data;
      assert.equal(history.items[0].status, "NOT_ELIGIBLE");
    });

    it("never pays twice when the qualification runs twice", async () => {
      const friend = await signUp(code);
      await forgetIps();
      const order = await friendOrders(friend);
      const { Order } = await import("../models/order.model.js");
      await referrals.onOrderDelivered(await Order.findById(order.id));
      await referrals.creditReferral((await Referral.findOne({ referred: friend.user.id }))._id);
      assert.equal(await CoinTransaction.countDocuments({ source: "REFERRAL_REWARD" }), 2);
    });
  });
});
