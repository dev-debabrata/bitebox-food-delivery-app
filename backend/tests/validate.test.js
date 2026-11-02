import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { body, query } from "express-validator";
import supertest from "supertest";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { validate } from "../src/middleware/validate.middleware.js";

/** Tiny app echoing what reaches the controller after validation. */
function echo(rules) {
  const app = express();
  app.use(express.json());
  app.post("/", validate(rules), (req, res) => res.json({ body: req.body, query: req.validatedQuery }));
  app.use(errorHandler);
  return supertest(app);
}

describe("validate middleware", () => {
  it("keeps sanitised Dates and numbers", async () => {
    const res = await echo([body("from").isISO8601().toDate(), body("n").isInt().toInt()]).post("/").send({ from: "2026-01-01", n: "7" });
    assert.equal(res.body.body.from, "2026-01-01T00:00:00.000Z");
    assert.equal(res.body.body.n, 7);
  });

  it("drops fields that were not sent, including skipped nested chains", async () => {
    const rules = [body("address").optional().isObject(), body("address.city").if(body("address").exists()).isString(), body("name").optional().isString()];
    const res = await echo(rules).post("/").send({ name: "x" });
    assert.deepEqual(res.body.body, { name: "x" });
  });

  it("drops unknown fields and exposes typed query values", async () => {
    const res = await echo([body("a").isString(), query("page").optional().isInt().toInt()]).post("/?page=3").send({ a: "ok", role: "admin" });
    assert.deepEqual(res.body.body, { a: "ok" });
    assert.equal(res.body.query.page, 3);
  });
});
