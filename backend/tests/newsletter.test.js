import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { NewsletterSubscription } from "../models/newsletter-subscription.model.js";
import { buildApp, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";

describe("newsletter sign-up", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(resetDb);

  const subscribe = (email) => request(app).post("/api/v1/newsletter/subscriptions").send({ email });

  it("subscribes an email once and says so when it is repeated", async () => {
    const first = await subscribe("  Meera.Iyer@Example.com ");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { subscribed: true, alreadySubscribed: false });

    const again = await subscribe("meera.iyer@example.com");
    assert.equal(again.body.data.alreadySubscribed, true);
    assert.equal(again.body.message, "You're already subscribed");
    assert.equal(await NewsletterSubscription.countDocuments(), 1);
    assert.equal((await NewsletterSubscription.findOne()).email, "meera.iyer@example.com");
  });

  it("handles simultaneous duplicate requests", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => subscribe("kabir@example.com")));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(await NewsletterSubscription.countDocuments(), 1);
  });

  it("re-subscribes someone who unsubscribed", async () => {
    await NewsletterSubscription.create({ email: "asha@example.com", status: "unsubscribed" });
    const res = await subscribe("asha@example.com");
    assert.equal(res.body.data.alreadySubscribed, false);
    assert.equal((await NewsletterSubscription.findOne()).status, "subscribed");
  });

  it("rejects invalid input and ignores extra fields", async () => {
    for (const email of ["", "not-an-email", "a@b", 42]) {
      const res = await subscribe(email);
      assert.equal(res.status, 422, String(email));
    }
    const res = await request(app)
      .post("/api/v1/newsletter/subscriptions")
      .send({ email: "riya@example.com", status: "unsubscribed", source: "admin" });
    assert.equal(res.status, 200);
    const saved = await NewsletterSubscription.findOne();
    assert.equal(saved.status, "subscribed");
    assert.equal(saved.source, "footer");
    assert.equal(await NewsletterSubscription.countDocuments({ email: "" }), 0);
  });
});
