import crypto from "node:crypto";

export const slugify = (value) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";

export async function uniqueSlug(Model, value, excludeId) {
  const base = slugify(value);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate =
      attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
    const filter = {
      slug: candidate,
      ...(excludeId && { _id: { $ne: excludeId } }),
    };
    if (!(await Model.exists(filter))) return candidate;
  }
  throw new Error("Could not generate a unique slug");
}
