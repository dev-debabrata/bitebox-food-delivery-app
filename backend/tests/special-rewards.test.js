import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { CoinTransaction } from "../models/coin-transaction.model.js";
import { CoinWallet } from "../models/coin-wallet.model.js";
import { RewardCampaign, RewardClaim } from "../models/reward-campaign.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { User } from "../models/user.model.js";
import { updateRewardConfig } from "../services/reward-config.service.js";
import * as special from "../services/special-rewards.service.js";
import { buildApp, PASSWORD, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";
import { orderWorld } from "./rewards-helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("special rewards", () => {
  let app;
  let w;
  let admin;

  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(async () => {
    await resetDb();
    w = await orderWorld(app);
    admin = await User.findById(w.admin.user.id);
  });

  let n = 0;
  async function signUp() {
    n++;
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ name: "Meera Iyer", email: `meera${n}-${Date.now()}@example.com`, password: PASSWORD });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { token: res.body.data.accessToken, user: res.body.data.user };
  }
  const coinsOf = async (userId) => (await CoinWallet.findOne({ user: userId }).lean())?.available ?? 0;

  async function campaign(overrides = {}, { activate = true } = {}) {
    const now = Date.now();
    const c = await special.adminCreate(admin, {
      name: "Diwali Dhamaka",
      description: "Festival coins for everyone",
      type: "FESTIVAL",
      trigger: "CLAIM",
      rewardCoins: 40,
      startAt: new Date(now - HOUR),
      endAt: new Date(now + 3 * DAY),
      ...overrides,
    });
    return activate ? special.adminSetStatus(admin, c.id, "activate") : c;
  }
  const claimAs = (token, id) => w.api(token).post(`/api/v1/rewards/campaigns/${id}/claim`);

  describe("welcome", () => {
    it("pays new customers once on sign-up", async () => {
      const a = await signUp();
      assert.equal(await coinsOf(a.user.id), 25);
      await special.maybeWelcome(a.user.id, "registration");
      assert.equal(await coinsOf(a.user.id), 25);
      assert.equal(await RewardClaim.countDocuments({ user: a.user.id, rewardType: "WELCOME" }), 1);
      const overview = (await w.api(a.token).get("/api/v1/rewards")).body.data;
      assert.equal(overview.welcome.claimed, true);
    });

    it("can pay on the first delivered order instead", async () => {
      await updateRewardConfig(null, { welcome: { trigger: "first_order" } });
      const a = await signUp();
      assert.equal(await coinsOf(a.user.id), 0);
      await w.fillCart({ token: a.token });
      const { order } = await w.place("cod", { token: a.token, userId: a.user.id });
      await w.deliver(order.id);
      assert.equal(await CoinTransaction.countDocuments({ user: a.user.id, source: "WELCOME_REWARD" }), 1);
    });
  });

  describe("birthday", () => {
    it("saves the date once and validates it", async () => {
      const a = await signUp();
      assert.equal((await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "1995-02-30" })).status, 422);
      assert.equal((await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "2020-01-01" })).status, 422);
      assert.equal((await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "05/11/1995" })).status, 422);
      assert.equal((await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "1995-11-05" })).status, 200);
      const again = await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "1996-01-01" });
      assert.equal(again.status, 409);
      assert.equal((await User.findById(a.user.id)).birthDate.toISOString().slice(0, 10), "1995-11-05");
    });

    it("pays once per birthday year, on the local calendar day", async () => {
      const a = await signUp();
      await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "1995-11-05" });
      // 20:00 UTC on 4 Nov is already 5 Nov in India.
      const first = await special.birthdaySweep({ now: new Date("2026-11-04T20:00:00Z") });
      assert.equal(first.issued, 1);
      await special.birthdaySweep({ now: new Date("2026-11-05T10:00:00Z") });
      assert.equal(await coinsOf(a.user.id), 25 + 100);
      // Not on other days; again next year.
      assert.equal((await special.birthdaySweep({ now: new Date("2026-11-07T10:00:00Z") })).issued, 0);
      assert.equal((await special.birthdaySweep({ now: new Date("2027-11-05T10:00:00Z") })).issued, 1);
      assert.equal(await RewardClaim.countDocuments({ user: a.user.id, rewardType: "BIRTHDAY" }), 2);
    });

    it("celebrates 29 February on 28 February in other years", async () => {
      const a = await signUp();
      await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "2000-02-29" });
      assert.equal((await special.birthdaySweep({ now: new Date("2027-02-28T10:00:00Z") })).issued, 1);
      assert.equal((await special.birthdaySweep({ now: new Date("2028-02-28T10:00:00Z") })).issued, 0);
      assert.equal((await special.birthdaySweep({ now: new Date("2028-02-29T10:00:00Z") })).issued, 1);
    });

    it("pays nothing while birthday rewards are off", async () => {
      const a = await signUp();
      await w.api(a.token).put("/api/v1/rewards/birthday", { birthDate: "1995-11-05" });
      await updateRewardConfig(null, { birthday: { enabled: false } });
      assert.equal((await special.birthdaySweep({ now: new Date("2026-11-05T10:00:00Z") })).issued, 0);
    });
  });

  describe("campaigns", () => {
    it("lets an eligible customer claim once, and lists the campaign with its state", async () => {
      const c = await campaign();
      assert.equal(c.status, "ACTIVE");
      const a = await signUp();
      const list = (await w.api(a.token).get("/api/v1/rewards/campaigns")).body.data.items;
      assert.equal(list[0].canClaim, true);
      const res = await claimAs(a.token, c.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.claim.coins, 40);
      assert.equal(await coinsOf(a.user.id), 25 + 40);
      const second = await claimAs(a.token, c.id);
      assert.equal(second.status, 409);
      const after = (await w.api(a.token).get("/api/v1/rewards/campaigns")).body.data.items[0];
      assert.deepEqual([after.canClaim, after.reason], [false, "Already claimed"]);
      const history = (await w.api(a.token).get("/api/v1/rewards/history?rewardType=FESTIVAL")).body.data;
      assert.equal(history.items[0].campaign.name, "Diwali Dhamaka");
    });

    it("never pays a customer twice under concurrent claims", async () => {
      const c = await campaign();
      const a = await signUp();
      const results = await Promise.all(Array.from({ length: 6 }, () => claimAs(a.token, c.id)));
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(await RewardClaim.countDocuments({ campaign: c.id }), 1);
      assert.equal((await RewardCampaign.findById(c.id)).stats.claims, 1);
      assert.equal(await coinsOf(a.user.id), 25 + 40);
    });

    it("enforces the total claim limit and completes the campaign", async () => {
      const c = await campaign({ limits: { maxTotalClaims: 2 } });
      const people = [await signUp(), await signUp(), await signUp()];
      const results = await Promise.all(people.map((p) => claimAs(p.token, c.id)));
      assert.equal(results.filter((r) => r.status === 201).length, 2);
      const saved = await RewardCampaign.findById(c.id);
      assert.equal(saved.stats.claims, 2);
      assert.equal(saved.status, "COMPLETED");
    });

    it("respects the coin budget and repeat claims per customer", async () => {
      const c = await campaign({ rewardCoins: 30, limits: { maxClaimsPerCustomer: 3, maxTotalCoins: 70 } });
      const a = await signUp();
      assert.equal((await claimAs(a.token, c.id)).status, 201);
      assert.equal((await claimAs(a.token, c.id)).status, 201);
      assert.equal((await claimAs(a.token, c.id)).status, 409, "a third 30 would exceed 70 coins");
      assert.equal((await RewardCampaign.findById(c.id)).stats.coins, 60);
    });

    it("refuses customers outside the target group", async () => {
      const forNew = await campaign({ conditions: { customerGroup: "NEW" } });
      const forExisting = await campaign({ name: "Loyalty thanks", conditions: { customerGroup: "EXISTING" } });
      const a = await signUp();
      assert.equal((await claimAs(a.token, forExisting.id)).status, 409);
      await w.fillCart({ token: a.token });
      const { order } = await w.place("cod", { token: a.token, userId: a.user.id });
      await w.deliver(order.id);
      const res = await claimAs(a.token, forNew.id);
      assert.equal(res.status, 409);
      assert.match(res.body.message, /not ordered yet/);
      assert.equal((await claimAs(a.token, forExisting.id)).status, 201);
    });

    it("follows the campaign dates: scheduled, then active, then expired", async () => {
      const now = Date.now();
      const c = await campaign({ startAt: new Date(now + DAY), endAt: new Date(now + 3 * DAY) });
      assert.equal(c.status, "SCHEDULED");
      const a = await signUp();
      const early = await claimAs(a.token, c.id);
      assert.equal(early.status, 409);
      assert.match(early.body.message, /Not started/);

      const { campaignSweep } = special;
      assert.equal((await campaignSweep({ now: new Date(now + DAY + HOUR) })).started, 1);
      assert.equal((await RewardCampaign.findById(c.id)).status, "ACTIVE");
      await RewardCampaign.updateOne({ _id: c.id }, { startAt: new Date(now - HOUR) }); // so a claim "now" is inside it
      assert.equal((await claimAs(a.token, c.id)).status, 201);

      assert.equal((await campaignSweep({ now: new Date(now + 4 * DAY) })).ended, 1);
      assert.equal((await RewardCampaign.findById(c.id)).status, "EXPIRED");
      const b = await signUp();
      assert.equal((await claimAs(b.token, c.id)).status, 409);
    });

    it("pays order campaigns once per qualifying delivered order", async () => {
      const restaurant = await Restaurant.findOne({ slug: "spice-route-kitchen" });
      const c = await campaign({
        name: "Weekend feast",
        type: "PROMOTIONAL",
        trigger: "ORDER",
        rewardCoins: 75,
        conditions: { minOrderPaise: 50_000, restaurants: [restaurant._id] },
        limits: { maxClaimsPerCustomer: 5 },
      });
      const a = await signUp();
      // Claim campaigns are claimed; order campaigns are earned.
      assert.equal((await claimAs(a.token, c.id)).status, 409);

      await w.fillCart({ token: a.token, quantity: 1 }); // ₹349: below ₹500
      let placed = await w.place("cod", { token: a.token, userId: a.user.id });
      await w.deliver(placed.order.id);
      assert.equal(await RewardClaim.countDocuments({ campaign: c.id }), 0);

      await w.fillCart({ token: a.token, quantity: 2 }); // ₹698
      placed = await w.place("cod", { token: a.token, userId: a.user.id });
      await w.deliver(placed.order.id);
      assert.equal(await RewardClaim.countDocuments({ campaign: c.id }), 1);
      const { Order } = await import("../models/order.model.js");
      await special.onOrderDelivered(await Order.findById(placed.order.id));
      assert.equal(await RewardClaim.countDocuments({ campaign: c.id }), 1, "same order: no second reward");
    });

    it("pays first-order campaigns only for the first delivered order", async () => {
      const c = await campaign({ trigger: "ORDER", conditions: { firstOrderOnly: true }, limits: { maxClaimsPerCustomer: 5 } });
      const a = await signUp();
      for (let i = 0; i < 2; i++) {
        await w.fillCart({ token: a.token });
        const { order } = await w.place("cod", { token: a.token, userId: a.user.id });
        await w.deliver(order.id);
      }
      assert.equal(await RewardClaim.countDocuments({ campaign: c.id }), 1);
    });

    it("does not pay from paused or draft campaigns", async () => {
      const draft = await campaign({}, { activate: false });
      const paused = await campaign({ name: "Holi colours" });
      await special.adminSetStatus(admin, paused.id, "pause");
      const a = await signUp();
      assert.equal((await claimAs(a.token, draft.id)).status, 404);
      assert.equal((await claimAs(a.token, paused.id)).status, 409);
    });

    it("keeps running campaigns' promises: the reward cannot change while active", async () => {
      const c = await campaign();
      await assert.rejects(special.adminUpdate(admin, c.id, { rewardCoins: 500 }), /Pause the campaign/);
      const updated = await special.adminUpdate(admin, c.id, { name: "Diwali Dhamaka 2026", limits: { maxTotalClaims: 100 } });
      assert.equal(updated.name, "Diwali Dhamaka 2026");
      await assert.rejects(special.adminCreate(admin, { name: "Bad dates", type: "FESTIVAL", rewardCoins: 10, startAt: new Date(), endAt: new Date(Date.now() - DAY) }), /Validation failed/);
    });

    it("finishes claims a crash left pending", async () => {
      const a = await signUp();
      await RewardClaim.create({ user: a.user.id, rewardType: "PROMOTIONAL", coins: 15, claimKey: "manual:test", status: "PENDING", updatedAt: new Date(Date.now() - DAY) });
      await RewardClaim.updateOne({ claimKey: "manual:test" }, { $set: { updatedAt: new Date(Date.now() - DAY) } }, { timestamps: false });
      const summary = await special.campaignSweep({ now: new Date() });
      assert.equal(summary.recovered, 1);
      assert.equal(await coinsOf(a.user.id), 25 + 15);
    });
  });
});
