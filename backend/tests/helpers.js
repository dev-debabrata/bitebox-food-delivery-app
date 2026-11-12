import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import supertest from "supertest";
import { createApp } from "../app.js";
import { testOutbox } from "../services/mail.service.js";

export const ORIGIN = "http://localhost:4200";
export const PASSWORD = "Sup3rSecret!";

let mongo;

/**
 * Connects to an isolated test database: an in-memory MongoDB by default, or
 * TEST_MONGO_URI when set (e.g. where local mongod cannot run). Because tests
 * wipe collections, a TEST_MONGO_URI database name must end in "_test".
 */
export async function setupTestDb() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Tests must run with NODE_ENV=test");
  const externalUri = process.env.TEST_MONGO_URI;
  if (externalUri) {
    await mongoose.connect(externalUri, { serverSelectionTimeoutMS: 15000 });
    if (!mongoose.connection.name.endsWith("_test")) {
      await mongoose.disconnect();
      throw new Error(
        `Refusing to run tests against non-test database "${mongoose.connection.name}"`,
      );
    }
  } else {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  }
  // Build every model's indexes (e.g. the 2dsphere index $geoNear needs).
  await mongoose.connection.syncIndexes();
  await resetDb();
}

export async function teardownTestDb() {
  await mongoose.disconnect();
  await mongo?.stop();
}

export async function resetDb() {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})),
  );
  testOutbox.length = 0;
}

export function buildApp(options) {
  return createApp({
    rateLimits: { authRateLimit: 1000, sensitiveRateLimit: 1000 },
    ...options,
  });
}

export const request = (app) => supertest(app);

export async function registerUser(app, overrides = {}) {
  const body = {
    name: "Test User",
    email: `user${Math.random().toString(36).slice(2)}@example.com`,
    password: PASSWORD,
    ...overrides,
  };
  const res = await supertest(app).post("/api/v1/auth/register").send(body);
  return {
    res,
    body,
    token: res.body.data?.accessToken,
    cookie: res.headers["set-cookie"],
  };
}

/** Creates a user directly in the DB (e.g. an admin, which cannot self-register) and signs in. */
export async function createAndLogin(app, role) {
  const { seedUsers, SEED_USERS } = await import("../scripts/seed.js");
  await seedUsers(PASSWORD);
  const email = SEED_USERS.find((u) => u.role === role).email;
  const res = await supertest(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD });
  return { token: res.body.data.accessToken, user: res.body.data.user };
}

/** Creates an approved restaurant (with categories and menu) via the seed helpers. */
export async function seedCatalogFor(app) {
  const owner = await createAndLogin(app, "restaurant");
  const { seedCatalog } = await import("../scripts/seed.js");
  await seedCatalog();
  return owner;
}

export const refreshCookie = (setCookie) =>
  setCookie?.find((c) => c.startsWith("bb_refresh="))?.split(";")[0];

/**
 * Body for PATCH /delivery/orders/:id/status. With "delivered" it adds the customer's delivery
 * code from the database (as the customer would read it out), unless `otp` is given.
 */
export async function riderStatusBody(orderId, status, otp) {
  if (status !== "delivered") return { status };
  const { Order } = await import("../models/order.model.js");
  const code =
    otp ?? (await Order.findById(orderId).select("deliveryOtp"))?.deliveryOtp;
  return code ? { status, otp: code } : { status };
}
