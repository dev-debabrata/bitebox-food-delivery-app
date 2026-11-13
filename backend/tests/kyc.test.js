// Partner verification: documents, bank account, admin review and restaurant approval rules
// (same as backend-django/apps/kyc/tests/test_kyc.py).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { AuditLog } from "../models/audit-log.model.js";
import { KycDocument, PayoutAccount } from "../models/kyc-document.model.js";
import { Notification } from "../models/notification.model.js";
import { Restaurant, isOpenAt } from "../models/restaurant.model.js";
import { flushAudits } from "../services/audit.service.js";
import { useRestaurantKyc } from "../services/restaurant.service.js";
import { decrypt } from "../utils/field-crypto.js";
import { buildApp, createAndLogin, request, resetDb, seedCatalogFor, setupTestDb, teardownTestDb } from "./helpers.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const FSSAI = "12345678901234";

describe("KYC", () => {
  let app;
  let owner;
  let ops;
  let kitchen;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(async () => {
    useRestaurantKyc(null);
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    owner = await seedCatalogFor(app);
    kitchen = await Restaurant.findOneAndUpdate({ owner: owner.user.id }, { status: "pending" }, { returnDocument: "after" });
    ops = await createAndLogin(app, "operations_admin"); // restaurants:manage
  });

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    put: (url, body) => request(app).put(url).set("Authorization", `Bearer ${token}`).send(body),
    patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
    post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
    del: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
  });
  const upload = (token, kind, number = "", data = PDF) =>
    request(app).post("/api/v1/kyc/documents").set("Authorization", `Bearer ${token}`).field("kind", kind).field("number", number).attach("file", data, "doc.pdf");
  const review = (docId, status, note) => as(ops.token).patch(`/api/v1/admin/kyc/documents/${docId}`, { status, ...(note && { note }) });

  it("keeps documents private to their owner and reviewers, numbers encrypted", async () => {
    const res = await upload(owner.token, "fssai_licence", FSSAI);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const doc = res.body.data.document;
    assert.equal(doc.numberLast4, "1234");
    const stored = await KycDocument.findOne();
    assert.ok(!stored.numberEncrypted.includes(FSSAI));
    assert.equal(decrypt(stored.numberEncrypted), FSSAI);

    const summary = (await as(owner.token).get("/api/v1/kyc")).body.data;
    assert.deepEqual(summary.checklist.map((i) => i.kind), ["fssai_licence", "pan_card", "cancelled_cheque"]);
    assert.equal(summary.complete, false);
    const file = await as(owner.token).get(`/api/v1/kyc/documents/${doc.id}/file`).buffer(true);
    assert.equal(file.status, 200);
    assert.equal(file.headers["cache-control"], "private, no-store");

    const rider = await createAndLogin(app, "delivery");
    assert.equal((await as(rider.token).get(`/api/v1/kyc/documents/${doc.id}/file`)).status, 404);
    assert.equal((await as(ops.token).get(`/api/v1/admin/kyc/documents/${doc.id}/file`)).status, 200);
    await flushAudits(); // audit rows are written after the response
    assert.equal(await AuditLog.countDocuments({ action: "kyc.document.view" }), 1);
    const finance = await createAndLogin(app, "finance_admin");
    assert.equal((await as(finance.token).get(`/api/v1/admin/kyc/documents/${doc.id}/file`)).status, 403);
  });

  it("refuses bad uploads", async () => {
    for (const [kind, number, data, status] of [
      ["fssai_licence", FSSAI, Buffer.from("plain text"), 415],
      ["fssai_licence", "123", PDF, 400],
      ["driving_licence", "DL0420110012345", PDF, 400],
      ["fssai_licence", FSSAI, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 413],
    ])
      assert.equal((await upload(owner.token, kind, number, data)).status, status, `${kind} ${status}`);
    assert.equal(await KycDocument.countDocuments(), 0);
  });

  it("replaces documents on re-upload, keeps approved ones, and tells partners about rejections", async () => {
    const first = (await upload(owner.token, "pan_card", "ABCDE1234F")).body.data.document;
    assert.equal((await review(first.id, "approved")).status, 200);
    assert.equal((await as(owner.token).del(`/api/v1/kyc/documents/${first.id}`)).status, 409);
    const again = (await upload(owner.token, "pan_card", "ABCDE9999F")).body.data.document;
    assert.equal(again.id, first.id);
    assert.equal(again.status, "pending");
    assert.equal((await review(first.id, "rejected")).status, 400); // needs a note
    const rejected = await review(first.id, "rejected", "The PAN is blurred");
    assert.equal(rejected.body.data.document.reviewNote, "The PAN is blurred");
    const note = await Notification.findOne({ user: owner.user.id, type: "kyc.document_rejected" });
    assert.equal(note.link, "/restaurant/verification");
  });

  it("masks and encrypts the bank account", async () => {
    const body = { holderName: "Spice Route Foods", accountNumber: "123456789012", ifsc: "HDFC0001234" };
    assert.equal((await as(owner.token).put("/api/v1/kyc/payout-account", { ...body, ifsc: "BAD" })).status, 400);
    const res = await as(owner.token).put("/api/v1/kyc/payout-account", body);
    assert.equal(res.body.data.payoutAccount.accountLast4, "9012");
    assert.equal(res.body.data.payoutAccount.accountNumber, undefined);
    assert.ok(!(await PayoutAccount.findOne()).accountNumberEncrypted.includes("123456789012"));
  });

  it("puts a restaurant live only after verification, via documents needed and resubmit", async () => {
    useRestaurantKyc(true);
    try {
      const admin = await createAndLogin(app, "admin");
      const status = (s, reason) => as(admin.token).patch(`/api/v1/admin/restaurants/${kitchen.id}/status`, { status: s, ...(reason && { reason }) });
      await Restaurant.updateOne({ _id: kitchen._id }, { $unset: { fssaiNumber: 1 } });
      const blocked = await status("approved");
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, "KYC_INCOMPLETE");
      assert.match(blocked.body.message, /FSSAI number.*Bank account/);
      assert.equal((await status("resubmission_requested")).status, 400);
      assert.equal((await status("resubmission_requested", "Upload your FSSAI licence")).status, 200);

      await Restaurant.updateOne({ _id: kitchen._id }, { fssaiNumber: FSSAI });
      for (const [kind, number] of [["fssai_licence", FSSAI], ["pan_card", "ABCDE1234F"], ["cancelled_cheque", ""]])
        await review((await upload(owner.token, kind, number)).body.data.document.id, "approved");
      await as(owner.token).put("/api/v1/kyc/payout-account", { holderName: "Owner", accountNumber: "123456789012", ifsc: "HDFC0001234" });
      assert.equal((await as(owner.token).post("/api/v1/my/restaurant/resubmit")).body.data.restaurant.status, "pending");
      assert.equal((await as(owner.token).post("/api/v1/my/restaurant/resubmit")).status, 409);
      assert.equal((await status("approved")).status, 200);
    } finally {
      useRestaurantKyc(null);
    }
  });

  it("asks GST-registered restaurants for a GSTIN and its certificate", async () => {
    assert.equal((await as(owner.token).patch("/api/v1/my/restaurant", { gstRegistered: true })).status, 422);
    const ok = await as(owner.token).patch("/api/v1/my/restaurant", { gstRegistered: true, gstin: "29ABCDE1234F1Z5" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const kinds = (await as(owner.token).get("/api/v1/kyc")).body.data.checklist.map((i) => i.kind);
    assert.ok(kinds.includes("gst_certificate"));
  });

  it("uses weekly hours to decide when the restaurant is open", async () => {
    const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [{ open: "09:00", close: "22:00" }]]));
    Object.assign(hours, { sat: [{ open: "18:00", close: "02:00" }], sun: [] });
    assert.equal((await as(owner.token).patch("/api/v1/my/restaurant", { weeklyHours: hours })).status, 200);
    assert.equal((await as(owner.token).patch("/api/v1/my/restaurant", { weeklyHours: { mon: [{ open: "9" }] } })).status, 422);
    const r = await Restaurant.findById(kitchen._id);
    const at = (day, hh, mm) => new Date(`2026-11-${day}T${hh}:${mm}:00+05:30`);
    assert.ok(isOpenAt(r, at(16, "10", "00"))); // Monday
    assert.ok(!isOpenAt(r, at(16, "23", "00")));
    assert.ok(isOpenAt(r, at(21, "23", "30"))); // Saturday night
    assert.ok(isOpenAt(r, at(22, "01", "30"))); // Sunday, still Saturday's late slot
    assert.ok(!isOpenAt(r, at(22, "12", "00"))); // Sunday closed
  });
});
