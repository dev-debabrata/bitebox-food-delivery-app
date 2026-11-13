// Security checks (same as backend-django/tests/test_security.py and test_input_fuzzing.py): token
// tampering, NoSQL operator injection, hostile query parameters, data exposure, headers, access
// to other people's data (IDOR), spreadsheet formula injection, photo metadata and log redaction.
// The role × endpoint matrix is in security-access.test.js.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import pino from "pino";
import { env } from "../config/env.js";
import { redactOptions } from "../config/logger.js";
import { ALL_ROLES } from "../config/roles.js";
import { Address } from "../models/address.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Notification } from "../models/notification.model.js";
import { Order } from "../models/order.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { User } from "../models/user.model.js";
import { spreadsheetSafe } from "../services/finance.service.js";
import { useImageStorage } from "../services/upload.service.js";
import { stripMetadata } from "../utils/image-metadata.js";
import { signAccessToken } from "../utils/tokens.js";
import { PASSWORD, buildApp, createAndLogin, registerUser, request, resetDb, setupTestDb, teardownTestDb } from "./helpers.js";
import { auth as bearer, orderWorld } from "./rewards-helpers.js";
import { allows, appWithRoutes, routeTable } from "./route-table.js";

const app = await appWithRoutes(() => buildApp());
const routes = routeTable(app);
const ME = "/api/v1/auth/me";
let n = 0;
const makeUser = (role) =>
  User.create({ name: `Test ${role}`, email: `sec${++n}@example.com`, passwordHash: "never-signs-in", role, phone: `98${String(n).padStart(8, "0")}` });

describe("security", () => {
  before(setupTestDb);
  after(teardownTestDb);
  beforeEach(resetDb);

  describe("tokens", () => {
    const claims = (u, extra = {}) => ({ sub: String(u._id), role: u.role, tv: u.tokenVersion ?? 0, iss: env.jwt.issuer, aud: env.jwt.audience, ...extra });
    const sign = (payload, secret = env.jwt.secret, options = {}) => jwt.sign(payload, secret, { expiresIn: "5m", ...options });

    it("refuses forged and altered access tokens", async () => {
      const u = await makeUser("customer");
      assert.equal((await request(app).get(ME).set(bearer(signAccessToken(u)))).status, 200);
      const forged = {
        "wrong key": sign(claims(u), "x".repeat(48)),
        "alg none": jwt.sign(claims(u), null, { algorithm: "none" }),
        expired: jwt.sign({ ...claims(u), exp: Math.floor(Date.now() / 1000) - 5 }, env.jwt.secret),
        "other audience": sign(claims(u, { aud: "someone-else" })),
        "other issuer": sign(claims(u, { iss: "someone-else" })),
        "unknown user": sign(claims(u, { sub: "650000000000000000000000" })),
        "text version": sign(claims(u, { tv: "0" })),
      };
      for (const [name, token] of Object.entries(forged))
        assert.equal((await request(app).get(ME).set(bearer(token))).status, 401, name);
      for (const header of ["Bearer", "Basic abc", "Token x", `bearer ${signAccessToken(u)}`])
        assert.equal((await request(app).get(ME).set("Authorization", header)).status, 401, header);
    });

    it("takes the role from the database, not the token", async () => {
      const u = await makeUser("customer");
      const token = sign(claims(u, { role: "admin" }));
      assert.equal((await request(app).get("/api/v1/admin/users").set(bearer(token))).status, 403);
    });

    it("stops old tokens after a password change or suspension", async () => {
      const u = await makeUser("customer");
      const token = signAccessToken(u);
      await User.updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
      assert.equal((await request(app).get(ME).set(bearer(token))).status, 401);
      const other = await makeUser("customer");
      const otherToken = signAccessToken(other);
      await User.updateOne({ _id: other._id }, { status: "suspended" });
      assert.equal((await request(app).get(ME).set(bearer(otherToken))).status, 401);
    });
  });

  describe("hostile input", () => {
    it("rejects MongoDB operators in JSON bodies", async () => {
      const { body } = await registerUser(app);
      const tries = [
        ["/api/v1/auth/login", { email: { $gt: "" }, password: { $gt: "" } }],
        ["/api/v1/auth/login", { email: body.email, password: { $ne: "x" } }],
        ["/api/v1/auth/forgot-password", { email: { $regex: ".*" } }],
        ["/api/v1/auth/reset-password", { token: { $ne: "" }, password: PASSWORD }],
        ["/api/v1/referrals/validate", { code: { $ne: "" } }],
      ];
      for (const [url, payload] of tries) {
        const res = await request(app).post(url).send(payload);
        assert.ok([400, 401, 404, 422].includes(res.status), `${url} -> ${res.status}`);
        assert.equal(res.body.data?.accessToken, undefined);
      }
    });

    it("never answers hostile query parameters with a server error", async () => {
      const PAYLOADS = ["' OR '1'='1' --", '{"$gt": ""}', "a\u0000b", "(a+)+$", "-1", "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ☃", "x".repeat(5000)];
      const PARAMS = ["search", "q", "status", "type", "method", "provider", "sort", "cuisine", "category", "restaurant", "restaurantId", "veg", "from", "to", "days", "lat", "lng", "rating", "orderState", "role", "page", "limit"];
      const tokens = {};
      for (const role of ALL_ROLES) tokens[role] = signAccessToken(await makeUser(role));
      const errors = [];
      for (const r of routes.filter((r) => r.method === "get")) {
        const role = [undefined, ...ALL_ROLES].find((x) => allows(r, x));
        if (role === undefined && !allows(r, undefined)) continue;
        for (const payload of PAYLOADS) {
          // All parameters at once (short values only: Node refuses request lines over 16 KB before
          // the app sees them), then the search alone, and bracket syntax that must not nest.
          const all = payload.length <= 400 ? [Object.fromEntries(PARAMS.map((p) => [p, payload]))] : [];
          for (const query of [...all, { search: payload }, { "search[$ne]": payload.slice(0, 20) }]) {
            const req = request(app).get(r.url).query(query);
            const res = await (role ? req.set(bearer(tokens[role])) : req);
            if (res.status >= 500 && res.status !== 503) {
              errors.push(`${role} GET ${r.path} ${Object.keys(query)[0]}=${JSON.stringify(payload.slice(0, 20))} -> ${res.status}`);
              break;
            }
          }
        }
      }
      assert.deepEqual(errors, []);
    });
  });

  describe("data exposure and headers", () => {
    const SECRET = /password|hash|tokenversion|refresh|otp|secret/i;
    const keys = (v) =>
      Array.isArray(v) ? v.flatMap(keys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];

    it("never returns password hashes or token internals", async () => {
      const { res, token } = await registerUser(app);
      const me = await request(app).get(ME).set(bearer(token));
      const admin = (await createAndLogin(app, "admin")).token;
      const users = await request(app).get("/api/v1/admin/users").set(bearer(admin));
      const detail = await request(app).get(`/api/v1/admin/users/${me.body.data.user.id}`).set(bearer(admin));
      for (const body of [res.body, me.body, users.body, detail.body])
        assert.deepEqual(keys(body).filter((k) => SECRET.test(k)), []);
    });

    it("sends the security headers", async () => {
      const res = await request(app).get("/api/v1/health/live");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.ok(res.headers["x-frame-options"]);
      assert.ok(res.headers["referrer-policy"]);
      assert.equal(res.headers["x-powered-by"], undefined);
    });
  });

  describe("other people's data (IDOR)", () => {
    it("keeps every id-taking route to its owner", async () => {
      const w = await orderWorld(app);
      const placed = (await w.fillCart(), await w.place("cod"));
      const orderId = placed.order.id;
      await w.deliver(orderId);
      const address = await Address.findOne({ user: w.customer.user.id });
      const food = await FoodItem.findOne();
      const restaurant = await Restaurant.findOne({ owner: w.owner.user.id });
      const finance = (await createAndLogin(app, "finance_admin")).token;
      const payout = await request(app).post("/api/v1/admin/finance/payouts").set(bearer(finance)).send({ type: "restaurant", payeeId: String(restaurant._id) });
      const ticket = await w.api(w.customer.token).post("/api/v1/support/tickets", { type: "other", subject: "Need help please", message: "Something went wrong" });
      const notification = await Notification.findOne({ user: w.customer.user.id });
      const ids = {
        addresses: String(address._id),
        foods: String(food._id),
        payouts: payout.body.data.payout.id,
        tickets: ticket.body.data.ticket.id,
        notifications: String(notification._id),
      };

      const otherOwner = await makeUser("restaurant");
      const { _id, slug, name, owner: _owner, ...rest } = restaurant.toObject();
      await Restaurant.create({ ...rest, owner: otherOwner._id, slug: `${slug}-other`, name: `${name} Other` });
      const attackers = {
        customer: signAccessToken(await makeUser("customer")),
        restaurant: signAccessToken(otherOwner),
        delivery: signAccessToken(await makeUser("delivery")),
      };
      const leaks = [];
      let probed = 0;
      for (const r of routes) {
        if (!r.path.includes("{") || /\/api\/v1\/(admin|restaurants|foods)\b/.test(r.path)) continue;
        if (/\/cart\/|\/response$|\/reviews\/\{id\}$/.test(r.path)) continue; // own cart; reviews have own tests
        const kind = Object.keys(ids).find((k) => r.path.includes(`/${k}/`));
        const url = r.path.replace(/\{\w+\}/g, kind ? ids[kind] : orderId);
        for (const [role, token] of Object.entries(attackers)) {
          if (!allows(r, role)) continue;
          probed++;
          const res = await request(app)[r.method](url).set(bearer(token)).send({ status: "cancelled", reason: "x", body: "hello there" });
          if (![403, 404, 409, 422].includes(res.status)) leaks.push(`${role} ${r.method.toUpperCase()} ${url} -> ${res.status}`);
        }
      }
      assert.deepEqual(leaks, []);
      assert.ok(probed >= 25, `only ${probed} probes`);
      assert.equal((await Order.findById(orderId)).status, "delivered");
      assert.ok(await Address.exists({ _id: address._id }));
    });
  });

  describe("files", () => {
    it("neutralises spreadsheet formulas in partner-written text", async () => {
      assert.equal(spreadsheetSafe("=HYPERLINK(1)"), "'=HYPERLINK(1)");
      for (const c of "=+-@\t\r") assert.ok(spreadsheetSafe(`${c}x`).startsWith("'"));
      assert.equal(spreadsheetSafe("Spice Route"), "Spice Route");

      const w = await orderWorld(app);
      await Restaurant.updateOne({ owner: w.owner.user.id }, { name: "=cmd|' /C calc'!A0" });
      await w.fillCart();
      const { order } = await w.place("cod");
      await w.deliver(order.id);
      const finance = (await createAndLogin(app, "finance_admin")).token;
      const csv = (await request(app).get("/api/v1/admin/finance/settlements.csv").set(bearer(finance))).text;
      assert.ok(csv.includes("'=cmd|"), csv);
      assert.ok(!csv.includes(",=cmd"));
    });

    const GPS = Buffer.from("GPSLatitude 12.9716 N");
    const segment = (marker, payload) => {
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([head, payload]);
    };
    function jpegWithExif(orientation = 6) {
      const tiff = Buffer.alloc(38);
      tiff.write("MM", 0, "latin1");
      tiff.writeUInt16BE(0x2a, 2);
      tiff.writeUInt32BE(8, 4);
      tiff.writeUInt16BE(2, 8);
      tiff.writeUInt16BE(0x0112, 10); // Orientation
      tiff.writeUInt16BE(3, 12);
      tiff.writeUInt32BE(1, 14);
      tiff.writeUInt16BE(orientation, 18);
      tiff.writeUInt16BE(0x8825, 22); // GPS IFD pointer
      tiff.writeUInt16BE(4, 24);
      tiff.writeUInt32BE(1, 26);
      tiff.writeUInt32BE(38, 30);
      return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
        segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, GPS])),
        segment(0xfe, Buffer.from("taken at 221B Fictional Street")),
        segment(0xdb, Buffer.from([0, 1])),
        Buffer.from([0xff, 0xda, 0, 4, 0, 0, 0x12, 0x34, 0xff, 0xd9]),
      ]);
    }

    it("removes photo location and comments but keeps the orientation", () => {
      const clean = stripMetadata(jpegWithExif(6), "jpg");
      assert.ok(!clean.includes(GPS) && !clean.includes("Fictional Street"));
      assert.deepEqual([...clean.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]); // JFIF stays first
      assert.ok(clean.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])));
      assert.ok(clean.subarray(-4).equals(Buffer.from([0x12, 0x34, 0xff, 0xd9])));
      assert.ok(!stripMetadata(jpegWithExif(1), "jpg").includes("Exif"));
      for (const [data, kind] of [
        [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "jpg"],
        [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), "png"],
        [Buffer.from("RIFF\xff\xff\0\0WEBPVP8 ", "latin1"), "webp"],
      ])
        assert.throws(() => stripMetadata(data, kind));
    });

    it("stores uploaded review photos without their location", async () => {
      const saved = [];
      const restore = useImageStorage({ save: async (data) => (saved.push(data), "https://images.example/x.jpg") });
      try {
        const { token } = await createAndLogin(app, "customer");
        const ok = await request(app).post("/api/v1/uploads/review-images").set(bearer(token)).attach("image", jpegWithExif(6), "photo.jpg");
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        const broken = await request(app).post("/api/v1/uploads/review-images").set(bearer(token)).attach("image", Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]), "broken.jpg");
        assert.equal(broken.status, 415);
      } finally {
        restore();
      }
      assert.equal(saved.length, 1);
      assert.ok(!saved[0].includes(GPS));
    });
  });

  it("keeps tokens and passwords out of the logs", () => {
    const lines = [];
    const log = pino({ redact: redactOptions }, new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.info({ req: { headers: { authorization: "Bearer abc.def.ghi", cookie: "bb_refresh=xyz" } }, body: { password: "Hunter-22", otp: "123456", accessToken: "tok" } }, "request");
    const text = lines.join("");
    for (const secret of ["abc.def.ghi", "bb_refresh=xyz", "Hunter-22", "123456", '"tok"']) assert.ok(!text.includes(secret), secret);
  });
});
