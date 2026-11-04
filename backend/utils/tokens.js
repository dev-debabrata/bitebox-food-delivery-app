import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/** Cryptographically random opaque token (URL safe). */
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString("base64url");

/** Opaque tokens (refresh / reset) are only ever stored as SHA-256 hashes. */
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export const signAccessToken = (user) =>
  jwt.sign({ role: user.role, tv: user.tokenVersion ?? 0 }, env.jwt.secret, {
    subject: String(user._id),
    expiresIn: env.jwt.accessExpiresIn,
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
    algorithm: "HS256",
  });

export const verifyAccessToken = (token) =>
  jwt.verify(token, env.jwt.secret, {
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
    algorithms: ["HS256"],
  });
