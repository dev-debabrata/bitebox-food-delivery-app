import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Session } from "../models/session.model.js";
import { User } from "../models/user.model.js";
import { testOutbox } from "../services/mail.service.js";
import {
  ORIGIN,
  PASSWORD,
  buildApp,
  createAndLogin,
  refreshCookie,
  registerUser,
  request,
  resetDb,
  setupTestDb,
  teardownTestDb,
} from "./helpers.js";

const refreshWith = (app, cookie) =>
  request(app)
    .post("/api/v1/auth/refresh")
    .set("Origin", ORIGIN)
    .set("X-Requested-With", "BiteBox")
    .set("Cookie", cookie);

describe("Authentication", () => {
  let app;
  before(async () => {
    await setupTestDb();
    app = buildApp();
  });
  after(teardownTestDb);
  beforeEach(resetDb);

  describe("registration", () => {
    it("registers a customer, hashes the password and never returns it", async () => {
      const { res, body } = await registerUser(app, {
        email: "Asha@Example.com",
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.user.email, "asha@example.com");
      assert.equal(res.body.data.user.role, "customer");
      assert.equal(res.body.data.user.passwordHash, undefined);
      assert.ok(res.body.data.accessToken);

      const stored = await User.findOne({ email: "asha@example.com" }).select(
        "+passwordHash",
      );
      assert.notEqual(stored.passwordHash, body.password);
      assert.match(stored.passwordHash, /^\$2[aby]\$/);
    });

    it("sets the refresh token as an HttpOnly, SameSite cookie scoped to auth routes", async () => {
      const { cookie } = await registerUser(app);
      const raw = cookie.find((c) => c.startsWith("bb_refresh="));
      assert.match(raw, /HttpOnly/i);
      assert.match(raw, /SameSite=Strict/i);
      assert.match(raw, /Path=\/api\/v1\/auth/);
      // Only a hash is stored server-side.
      const session = await Session.findOne();
      assert.notEqual(session.tokenHash, refreshCookie(cookie).split("=")[1]);
    });

    it("allows restaurant and delivery self-registration", async () => {
      for (const role of ["restaurant", "delivery"]) {
        const { res } = await registerUser(app, { role });
        assert.equal(res.status, 201);
        assert.equal(res.body.data.user.role, role);
      }
    });

    it("rejects self-registration as admin", async () => {
      const { res } = await registerUser(app, { role: "admin" });
      assert.equal(res.status, 422);
      assert.equal(await User.countDocuments({ role: "admin" }), 0);
    });

    it("rejects duplicate emails with 409", async () => {
      await registerUser(app, { email: "dup@example.com" });
      const { res } = await registerUser(app, { email: "dup@example.com" });
      assert.equal(res.status, 409);
    });

    it("validates input and reports field errors", async () => {
      const { res } = await registerUser(app, {
        name: "A",
        email: "not-an-email",
        password: "short",
      });
      assert.equal(res.status, 422);
      const fields = res.body.error.details.map((d) => d.field).sort();
      assert.deepEqual(fields, ["email", "name", "password"]);
    });

    it("strips MongoDB operators from the request body", async () => {
      await registerUser(app, { email: "victim@example.com" });
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: { $gt: "" }, password: { $gt: "" } });
      assert.equal(res.status, 422);
    });
  });

  describe("login", () => {
    it("signs in with correct credentials", async () => {
      const { body } = await registerUser(app);
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: body.email, password: PASSWORD });
      assert.equal(res.status, 200);
      assert.ok(res.body.data.accessToken);
      assert.ok(refreshCookie(res.headers["set-cookie"]));
    });

    it("returns the same 401 for wrong password and unknown email", async () => {
      const { body } = await registerUser(app);
      const wrong = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: body.email, password: "Wrong-pass1" });
      const unknown = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.com", password: PASSWORD });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrong.body.message, unknown.body.message);
    });

    it("rejects signing in to a portal for a different role", async () => {
      const { body } = await registerUser(app);
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: body.email, password: PASSWORD, portal: "admin" });
      assert.equal(res.status, 403);
    });

    it("blocks suspended accounts", async () => {
      const { body } = await registerUser(app);
      await User.updateOne({ email: body.email }, { status: "suspended" });
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: body.email, password: PASSWORD });
      assert.equal(res.status, 403);
    });

    it("rate-limits repeated login attempts", async () => {
      const limited = buildApp({
        rateLimits: { authRateLimit: 3, sensitiveRateLimit: 3 },
      });
      const attempt = () =>
        request(limited)
          .post("/api/v1/auth/login")
          .send({ email: "x@example.com", password: "Wrong-pass1" });
      for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 429);
    });
  });

  describe("access tokens", () => {
    it("returns the current user for a valid token", async () => {
      const { token, body } = await registerUser(app);
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.email, body.email);
    });

    it("rejects missing, malformed and tampered tokens", async () => {
      const { token } = await registerUser(app);
      assert.equal((await request(app).get("/api/v1/auth/me")).status, 401);
      assert.equal(
        (
          await request(app)
            .get("/api/v1/auth/me")
            .set("Authorization", "Bearer nope")
        ).status,
        401,
      );
      const tampered =
        token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
      assert.equal(
        (
          await request(app)
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${tampered}`)
        ).status,
        401,
      );
    });

    it("invalidates tokens of suspended users immediately", async () => {
      const { token, body } = await registerUser(app);
      await User.updateOne({ email: body.email }, { status: "suspended" });
      assert.equal(
        (
          await request(app)
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${token}`)
        ).status,
        401,
      );
    });

    it("updates the profile with validated fields only", async () => {
      const { token } = await registerUser(app);
      const res = await request(app)
        .patch("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "New Name", phone: "+919876543210", role: "admin" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.name, "New Name");
      assert.equal(res.body.data.user.phone, "+919876543210");
      assert.equal(res.body.data.user.role, "customer");
    });
  });

  describe("refresh sessions", () => {
    it("rotates the refresh token and issues a new access token", async () => {
      const { cookie } = await registerUser(app);
      const res = await refreshWith(app, refreshCookie(cookie));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.accessToken);
      assert.notEqual(
        refreshCookie(res.headers["set-cookie"]),
        refreshCookie(cookie),
      );
    });

    it("requires the CSRF header and a trusted origin", async () => {
      const { cookie } = await registerUser(app);
      const noHeader = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", refreshCookie(cookie));
      assert.equal(noHeader.status, 403);
      const badOrigin = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Origin", "https://evil.example")
        .set("X-Requested-With", "BiteBox")
        .set("Cookie", refreshCookie(cookie));
      assert.equal(badOrigin.status, 403);
    });

    it("detects refresh-token reuse and revokes the whole session family", async () => {
      const { cookie } = await registerUser(app);
      const first = refreshCookie(cookie);
      const rotated = await refreshWith(app, first);
      const second = refreshCookie(rotated.headers["set-cookie"]);

      // Pretend the rotation happened outside the race grace window.
      await Session.updateOne(
        { revokedReason: "rotated" },
        { revokedAt: new Date(Date.now() - 60_000) },
      );

      const replay = await refreshWith(app, first);
      assert.equal(replay.status, 401);
      // The legitimate newer token is now revoked too.
      assert.equal((await refreshWith(app, second)).status, 401);
    });

    it("treats a near-simultaneous reuse as a race and reissues tokens", async () => {
      const { cookie } = await registerUser(app);
      const first = refreshCookie(cookie);
      const rotated = await refreshWith(app, first);
      assert.equal(rotated.status, 200);
      const race = await refreshWith(app, first);
      assert.equal(race.status, 200);
      assert.ok(race.body.data.accessToken);
      assert.ok(refreshCookie(race.headers["set-cookie"]));
      assert.equal(
        (await refreshWith(app, refreshCookie(race.headers["set-cookie"])))
          .status,
        200,
      );
    });

    it("logout revokes the refresh session", async () => {
      const { cookie } = await registerUser(app);
      const c = refreshCookie(cookie);
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Origin", ORIGIN)
        .set("X-Requested-With", "BiteBox")
        .set("Cookie", c);
      assert.equal(res.status, 200);
      assert.equal((await refreshWith(app, c)).status, 401);
    });
  });

  describe("password reset", () => {
    const tokenFromEmail = () =>
      new URL(
        testOutbox.at(-1).text.match(/https?:\/\/\S+/)[0],
      ).searchParams.get("token");

    it("responds identically for known and unknown emails", async () => {
      const { body } = await registerUser(app);
      const known = await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: body.email });
      const unknown = await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: "ghost@example.com" });
      assert.equal(known.status, 200);
      assert.equal(unknown.status, 200);
      assert.equal(known.body.message, unknown.body.message);
      assert.equal(testOutbox.length, 1);
    });

    it("stores only a hash of the reset token", async () => {
      const { body } = await registerUser(app);
      await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: body.email });
      const user = await User.findOne({ email: body.email }).select(
        "+passwordResetTokenHash",
      );
      assert.ok(user.passwordResetTokenHash);
      assert.notEqual(user.passwordResetTokenHash, tokenFromEmail());
    });

    it("resets the password once, revokes sessions and old access tokens", async () => {
      const { body, token: oldAccess, cookie } = await registerUser(app);
      await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: body.email });
      const token = tokenFromEmail();

      const reset = await request(app)
        .post("/api/v1/auth/reset-password")
        .send({ token, password: "Brand-new-pass9" });
      assert.equal(reset.status, 200);

      // Single use
      const again = await request(app)
        .post("/api/v1/auth/reset-password")
        .send({ token, password: "Another-pass9" });
      assert.equal(again.status, 400);

      // Old password fails, new one works
      assert.equal(
        (
          await request(app)
            .post("/api/v1/auth/login")
            .send({ email: body.email, password: PASSWORD })
        ).status,
        401,
      );
      assert.equal(
        (
          await request(app)
            .post("/api/v1/auth/login")
            .send({ email: body.email, password: "Brand-new-pass9" })
        ).status,
        200,
      );

      // Existing sessions and access tokens are invalidated
      assert.equal((await refreshWith(app, refreshCookie(cookie))).status, 401);
      assert.equal(
        (
          await request(app)
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${oldAccess}`)
        ).status,
        401,
      );
    });

    it("rejects expired reset tokens", async () => {
      const { body } = await registerUser(app);
      await request(app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: body.email });
      await User.updateOne(
        { email: body.email },
        { passwordResetExpiresAt: new Date(Date.now() - 1000) },
      );
      const res = await request(app)
        .post("/api/v1/auth/reset-password")
        .send({ token: tokenFromEmail(), password: "Brand-new-pass9" });
      assert.equal(res.status, 400);
    });

    it("change-password requires the current password and signs out other sessions", async () => {
      const { token, cookie } = await registerUser(app);
      const wrong = await request(app)
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: "Not-it-123", newPassword: "Changed-pass1" });
      assert.equal(wrong.status, 400);

      const ok = await request(app)
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: "Changed-pass1" });
      assert.equal(ok.status, 200);
      assert.equal((await refreshWith(app, refreshCookie(cookie))).status, 401);
    });
  });

  describe("role authorization", () => {
    it("allows admins to list users", async () => {
      const { token } = await createAndLogin(app, "admin");
      const res = await request(app)
        .get("/api/v1/admin/users?role=customer&limit=10")
        .set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.pagination.limit, 10);
      assert.ok(
        res.body.data.items.every(
          (u) => u.role === "customer" && !("passwordHash" in u),
        ),
      );
    });

    for (const role of ["customer", "restaurant", "delivery"]) {
      it(`forbids ${role} accounts from admin endpoints`, async () => {
        const { token } = await createAndLogin(app, role);
        const res = await request(app)
          .get("/api/v1/admin/users")
          .set("Authorization", `Bearer ${token}`);
        assert.equal(res.status, 403);
      });
    }

    it("requires authentication for admin endpoints", async () => {
      assert.equal((await request(app).get("/api/v1/admin/users")).status, 401);
    });

    it("allows admins to suspend and reactivate a user", async () => {
      const admin = await createAndLogin(app, "admin");
      const customer = await createAndLogin(app, "customer");

      // Suspend customer
      const suspendRes = await request(app)
        .patch(`/api/v1/admin/users/${customer.user.id}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "suspended" });
      assert.equal(suspendRes.status, 200);
      assert.equal(suspendRes.body.data.user.status, "suspended");

      // Customer's existing token should now be rejected
      const profileRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${customer.token}`);
      assert.equal(profileRes.status, 401);

      // Customer cannot login while suspended
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: customer.user.email, password: PASSWORD });
      assert.equal(loginRes.status, 403);

      // Reactivate customer
      const reactivateRes = await request(app)
        .patch(`/api/v1/admin/users/${customer.user.id}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "active" });
      assert.equal(reactivateRes.status, 200);
      assert.equal(reactivateRes.body.data.user.status, "active");

      // Customer can now log in
      const reLoginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: customer.user.email, password: PASSWORD });
      assert.equal(reLoginRes.status, 200);
    });

    it("prevents admin from suspending themselves", async () => {
      const admin = await createAndLogin(app, "admin");
      const res = await request(app)
        .patch(`/api/v1/admin/users/${admin.user.id}/status`)
        .set("Authorization", `Bearer ${admin.token}`)
        .send({ status: "suspended" });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /cannot suspend your own account/i);
    });
  });

  describe("seed", () => {
    it("is idempotent", async () => {
      const { seedUsers } = await import("../scripts/seed.js");
      const first = await seedUsers(PASSWORD);
      const second = await seedUsers(PASSWORD);
      assert.ok(first.every((r) => r.created));
      assert.ok(second.every((r) => !r.created));
      assert.equal(await User.countDocuments(), 4);
    });
  });
});
