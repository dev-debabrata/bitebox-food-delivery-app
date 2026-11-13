// Sign-in with an SMS code, phone and email verification, and the profile photo (same as
// backend-django/apps/accounts/tests/test_phone_email.py).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { env } from "../config/env.js";
import { OtpChallenge } from "../models/otp-challenge.model.js";
import { User } from "../models/user.model.js";
import { testOutbox } from "../services/mail.service.js";
import { testSmsOutbox, useChannel } from "../services/notification-channels.js";
import { useSignupCode } from "../services/auth.service.js";
import { useImageStorage } from "../services/upload.service.js";
import { buildApp, registerUser, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";

const PHONE = "9876543210";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("phone codes and email verification", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(async () => {
    useChannel("smsProvider", null);
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    useChannel("smsProvider", "test");
    testSmsOutbox.length = 0;
  });

  const signedUp = async (phone = PHONE) => {
    const { token, res } = await registerUser(app, { phone });
    const as = (method, url, body) => request(app)[method](url).set("Authorization", `Bearer ${token}`).send(body);
    return { as, user: res.body.data.user };
  };
  const requestCode = (phone = PHONE) => request(app).post("/api/v1/auth/otp/request").send({ phone });
  const lastCode = () => testSmsOutbox.at(-1).text.match(/\b(\d{6})\b/)[1];
  const codeLogin = (code, phone = PHONE, extra = {}) =>
    request(app).post("/api/v1/auth/otp/login").send({ phone, code, ...extra });
  const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  const verificationToken = () =>
    testOutbox.findLast((m) => m.subject === "Confirm your BiteBox email").text.match(/verify-email\?token=(\S+)/)[1];
  const verifyEmail = (token) => request(app).post("/api/v1/auth/email/verify").send({ token: decodeURIComponent(token) });

  it("signs in with the code sent to the number, once", async () => {
    const { user } = await signedUp();
    assert.equal(user.phoneVerified, false);
    const res = await requestCode();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { resendInSeconds: 30, expiresInSeconds: 300 });
    assert.equal(testSmsOutbox.at(-1).to, PHONE);
    assert.ok(!(await OtpChallenge.findOne()).codeHash.includes(lastCode()));
    const login = await codeLogin(lastCode());
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.data.user.id, user.id);
    assert.equal(login.body.data.user.phoneVerified, true);
    assert.ok(login.headers["set-cookie"].some((c) => c.startsWith("bb_refresh=")));
    assert.equal((await codeLogin(lastCode())).status, 400);
  });

  it("matches the number however it was typed", async () => {
    await signedUp(); // stored as 9876543210
    await requestCode("+919876543210");
    assert.equal((await codeLogin(lastCode(), "+919876543210")).status, 200);
  });

  it("answers unknown numbers the same way without texting them", async () => {
    const res = await requestCode("9123456780");
    assert.equal(res.status, 200);
    assert.match(res.body.message, /^If this number has a BiteBox account/);
    assert.equal(testSmsOutbox.length, 0);
    assert.ok([400, 401].includes((await codeLogin("123456", "9123456780")).status));
  });

  it("counts wrong codes down, then locks", async () => {
    await signedUp();
    await requestCode();
    const code = lastCode();
    const first = await codeLogin(wrong(code));
    assert.equal(first.status, 400);
    assert.match(first.body.message, /4 tries left/);
    for (let i = 0; i < 4; i++) await codeLogin(wrong(code));
    const locked = await codeLogin(code);
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, "OTP_LOCKED");
  });

  it("expires codes, waits before resending and limits codes per hour", async () => {
    await signedUp();
    await requestCode();
    await OtpChallenge.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    assert.match((await codeLogin(lastCode())).body.message, /expired/);
    const again = await requestCode();
    assert.equal(again.status, 429);
    assert.match(again.body.message, /^Wait/);
    const { resendSeconds } = env.otp;
    env.otp.resendSeconds = 0;
    try {
      for (let i = 0; i < 4; i++) assert.equal((await requestCode()).status, 200);
      assert.match((await requestCode()).body.message, /this number/);
    } finally {
      env.otp.resendSeconds = resendSeconds;
    }
  });

  it("applies the portal and suspension rules, and needs SMS", async () => {
    await signedUp();
    await requestCode();
    assert.equal((await codeLogin(lastCode(), PHONE, { portal: "admin" })).status, 403);
    await User.updateOne({ phone: PHONE }, { status: "suspended" });
    await OtpChallenge.deleteMany({});
    await requestCode();
    assert.equal(testSmsOutbox.length, 1); // no text for a suspended account
    const methods = async () => (await request(app).get("/api/v1/auth/methods")).body.data;
    assert.deepEqual(await methods(), { phone: true });
    useChannel("smsProvider", "");
    assert.equal((await requestCode("9000000111")).status, 503);
    assert.deepEqual(await methods(), { phone: false }); // the pages hide phone codes
    useChannel("smsProvider", "msg91"); // without MSG91_AUTH_KEY: still off
    assert.deepEqual(await methods(), { phone: false });
  });

  it("verifies a signed-in person's number, and a new number needs it again", async () => {
    const { as } = await signedUp();
    assert.equal((await as("post", "/api/v1/auth/phone/verification")).status, 200);
    const verified = await as("post", "/api/v1/auth/phone/verify", { code: lastCode() });
    assert.equal(verified.body.data.user.phoneVerified, true);
    assert.equal((await as("post", "/api/v1/auth/phone/verification")).status, 409);
    const changed = await as("patch", "/api/v1/auth/me", { phone: "9876500000" });
    assert.equal(changed.body.data.user.phoneVerified, false);
  });

  it("emails new accounts a link that verifies the address once", async () => {
    const { as, user } = await signedUp();
    assert.equal(user.emailVerified, false);
    const token = verificationToken();
    assert.equal((await verifyEmail(token)).status, 200);
    assert.equal((await as("get", "/api/v1/auth/me")).body.data.user.emailVerified, true);
    assert.equal((await verifyEmail(token)).status, 400);
    assert.equal((await as("post", "/api/v1/auth/email/verification")).status, 409);
  });

  it("replaces old links with new ones, and links expire", async () => {
    const { as } = await signedUp();
    const old = verificationToken();
    assert.equal((await as("post", "/api/v1/auth/email/verification")).status, 200);
    const fresh = verificationToken();
    assert.equal((await verifyEmail(old)).status, 400);
    await User.updateMany({}, { emailVerificationExpiresAt: new Date(Date.now() - 1000) });
    assert.equal((await verifyEmail(fresh)).status, 400);
  });

  it("only accepts profile photos uploaded here", async () => {
    const restore = useImageStorage({ save: async () => `${env.publicBaseUrl}/uploads/images/${crypto.randomUUID()}.png` });
    try {
      const { as } = await signedUp();
      const { token } = await registerUser(app);
      const upload = await request(app).post("/api/v1/uploads/avatars").set("Authorization", `Bearer ${token}`).attach("image", PNG, "me.png");
      assert.equal(upload.status, 201, JSON.stringify(upload.body));
      const me = await as("patch", "/api/v1/auth/me", { avatarUrl: upload.body.data.url });
      assert.equal(me.body.data.user.avatarUrl, upload.body.data.url);
      assert.equal((await as("patch", "/api/v1/auth/me", { avatarUrl: "https://evil.example/x.png" })).status, 400);
      const removed = await as("patch", "/api/v1/auth/me", { avatarUrl: null });
      assert.equal(removed.body.data.user.avatarUrl, undefined);
    } finally {
      restore();
    }
  });

  describe("sign-up confirmed by SMS", () => {
    const signup = (body = {}) =>
      request(app).post("/api/v1/auth/register").send({ name: "Meera Test", email: "meera@example.com", password: "Sup3rSecret!", phone: PHONE, ...body });
    const askCode = (email = "meera@example.com", phone = PHONE) => request(app).post("/api/v1/auth/register/code").send({ email, phone });
    beforeEach(() => useSignupCode(true));
    after(() => useSignupCode(null));

    it("creates the account only with the texted code", async () => {
      assert.equal((await askCode()).status, 200);
      assert.equal(testSmsOutbox.at(-1).to, PHONE);
      const without = await signup();
      assert.equal(without.status, 400);
      assert.equal(without.body.error.details[0].field, "code");
      assert.equal((await signup({ code: wrong(lastCode()) })).status, 400);
      assert.equal(await User.exists({ email: "meera@example.com" }), null);
      const created = await signup({ code: lastCode() });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.user.phoneVerified, true);
      assert.equal((await signup({ code: lastCode() })).status, 409);
    });

    it("sends no code for taken emails or numbers, and stays one step while SMS is off", async () => {
      useSignupCode(false);
      await signedUp();
      useSignupCode(true);
      assert.equal((await askCode("new@example.com")).status, 409);
      assert.equal(testSmsOutbox.length, 0);
      useChannel("smsProvider", "");
      assert.equal((await signup({ email: "other@example.com", phone: "9811122233" })).status, 201);
    });
  });
});
