import { User } from "../models/user.model.js";
import { escapeRegex } from "./pagination.js";

/** { id, name, email } for staff views, or null for a missing (deleted) account. */
export const personView = (u) =>
  u?.name ? { id: String(u._id), name: u.name, email: u.email } : null;

/** Ids of accounts whose name, email or one of `fields` contains `search` (at most 200). */
export async function matchingUserIds(search, fields = ["phone"]) {
  const pattern = new RegExp(escapeRegex(search), "i");
  const users = await User.find({ $or: ["name", "email", ...fields].map((f) => ({ [f]: pattern })) })
    .select("_id")
    .limit(200)
    .lean();
  return users.map((u) => u._id);
}
