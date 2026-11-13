// Rider registration and verification (same as backend-django/apps/delivery/tests/
// test_rider_verification.py): documents, bank account, address, and going online.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { Notification } from "../models/notification.model.js";
import { User } from "../models/user.model.js";
import { useRiderKyc } from "../services/delivery-partner.service.js";
import { buildApp, createAndLogin, registerUser, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const DOCS = [["driving_licence", "KA0120230001234"], ["vehicle_rc", "KA01AB1234"], ["id_proof", "AB1234567"]];
const ADDRESS = { line1: "4 Fictional Lane", city: "Bengaluru", state: "Karnataka", postalCode: "560001" };

describe("rider verification", () => {
  let app;
  let rider;
  let ops;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(async () => {
    useRiderKyc(null);
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    useRiderKyc(true);
    const { token, res } = await registerUser(app, { role: "delivery" });
    rider = { token, id: res.body.data.user.id };
    ops = await createAndLogin(app, "operations_admin");
  });

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    put: (url, body) => request(app).put(url).set("Authorization", `Bearer ${token}`).send(body),
    patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
    post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  });
  const goOnline = () => as(rider.token).patch("/api/v1/delivery/me/availability", { isOnline: true, latitude: 12.97, longitude: 77.59 });
  const verify = (status, reason) =>
    as(ops.token).patch(`/api/v1/admin/delivery-partners/${rider.id}/verification`, { status, ...(reason && { reason }) });
  async function complete() {
    for (const [kind, number] of DOCS) {
      const doc = await request(app).post("/api/v1/kyc/documents").set("Authorization", `Bearer ${rider.token}`).field("kind", kind).field("number", number).attach("file", PDF, "doc.pdf");
      assert.equal(doc.status, 201, JSON.stringify(doc.body));
      await as(ops.token).patch(`/api/v1/admin/kyc/documents/${doc.body.data.document.id}`, { status: "approved" });
    }
    await as(rider.token).put("/api/v1/kyc/payout-account", { holderName: "Ravi Test", accountNumber: "123456789012", ifsc: "SBIN0001234" });
    assert.equal((await as(rider.token).patch("/api/v1/delivery/me/details", { address: ADDRESS })).status, 200);
  }

  it("lets new riders go online only after verification", async () => {
    await as(rider.token).put("/api/v1/delivery/me/vehicle", { vehicleType: "motorbike" });
    const me = (await as(rider.token).get("/api/v1/delivery/me")).body.data.profile;
    assert.equal(me.verification.status, "pending");
    const blocked = await goOnline();
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "RIDER_NOT_VERIFIED");

    const early = await verify("approved");
    assert.equal(early.status, 409);
    for (const gap of ["Driving licence", "Vehicle registration", "Identity proof", "Bank account", "Address"])
      assert.ok(early.body.message.includes(gap), gap);
    const pending = (await as(ops.token).get("/api/v1/admin/delivery-partners?verification=pending")).body.data.items;
    assert.deepEqual(pending.map((i) => i.id), [rider.id]);

    await complete();
    assert.equal((await verify("approved")).body.data.profile.verification.status, "approved");
    assert.equal((await goOnline()).status, 200);
    assert.ok(await Notification.exists({ user: rider.id, type: "rider.verified" }));
  });

  it("takes the rider offline when documents are needed, until they resubmit", async () => {
    await as(rider.token).put("/api/v1/delivery/me/vehicle", { vehicleType: "scooter" });
    await complete();
    await verify("approved");
    await goOnline();
    assert.equal((await verify("resubmission_requested")).status, 400);
    assert.equal((await verify("resubmission_requested", "Your licence has expired")).status, 200);
    assert.equal((await DeliveryPartner.findOne({ user: rider.id })).isOnline, false);
    const note = await Notification.findOne({ user: rider.id, type: "rider.documents_needed" });
    assert.match(note.body, /licence has expired/);
    assert.equal((await goOnline()).status, 403);
    assert.equal((await as(rider.token).post("/api/v1/delivery/me/resubmit")).body.data.profile.verification.status, "pending");
    assert.equal((await as(rider.token).post("/api/v1/delivery/me/resubmit")).status, 409);
    assert.equal((await verify("approved")).status, 200);
  });

  it("counts riders from before verification existed as approved", async () => {
    const old = await User.create({ name: "Old Rider", email: "old.rider@example.com", passwordHash: "x", role: "delivery" });
    await DeliveryPartner.collection.insertOne({ user: old._id, vehicleType: "bicycle", isOnline: false, rating: { average: 0, count: 0 } });
    const detail = (await as(ops.token).get(`/api/v1/admin/delivery-partners/${old._id}`)).body.data;
    assert.equal(detail.profile.verification.status, "approved");
    const finance = await createAndLogin(app, "finance_admin");
    assert.equal((await as(finance.token).get(`/api/v1/admin/delivery-partners/${old._id}`)).status, 403);
    assert.equal((await as(rider.token).patch("/api/v1/delivery/me/details", { address: { city: "x" } })).status, 422);
  });
});
