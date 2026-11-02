/**
 * Development seed data. Safe to re-run: records are matched by email and
 * never duplicated. Refuses to run with NODE_ENV=production.
 *
 *   SEED_PASSWORD='Choose-a-dev-password1' npm run seed
 *   SEED_PASSWORD='...' npm run seed -- --reset-passwords   # also reset existing seed users
 *
 * Seeds one account per role, food categories, one approved restaurant
 * (owned by the restaurant account) and its menu, sample coupons and a
 * default delivery address for the customer, and the rider's vehicle profile.
 * All names and data are fictional.
 */
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { connectDB, disconnectDB } from "../config/db.js";
import { env } from "../config/env.js";
import { Address } from "../models/address.model.js";
import { Coupon } from "../models/coupon.model.js";
import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { FoodCategory } from "../models/food-category.model.js";
import { FoodItem } from "../models/food-item.model.js";
import { Restaurant } from "../models/restaurant.model.js";
import { ROLES, User } from "../models/user.model.js";

export const SEED_USERS = [
  { name: "BiteBox Admin", email: "admin@bitebox.test", phone: "9000000001", role: ROLES.ADMIN },
  { name: "Asha Customer", email: "customer@bitebox.test", phone: "9000000002", role: ROLES.CUSTOMER },
  { name: "Spice Route Owner", email: "restaurant@bitebox.test", phone: "9000000003", role: ROLES.RESTAURANT },
  { name: "Ravi Rider", email: "rider@bitebox.test", phone: "9000000004", role: ROLES.DELIVERY },
];

export async function seedUsers(password, { resetPasswords = false } = {}) {
  const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
  const results = [];
  for (const seed of SEED_USERS) {
    const update = { $setOnInsert: { ...seed, passwordHash } };
    if (resetPasswords) {
      delete update.$setOnInsert.passwordHash;
      update.$set = { passwordHash };
      update.$inc = { tokenVersion: 1 };
    }
    const result = await User.updateOne({ email: seed.email }, update, { upsert: true, runValidators: true });
    results.push({ email: seed.email, role: seed.role, created: result.upsertedCount === 1 });
  }
  return results;
}

export const SEED_CATEGORIES = [
  { name: "Biryani", slug: "biryani", icon: "rice_bowl", sortOrder: 10 },
  { name: "North Indian", slug: "north-indian", icon: "soup_kitchen", sortOrder: 20 },
  { name: "South Indian", slug: "south-indian", icon: "breakfast_dining", sortOrder: 30 },
  { name: "Chinese", slug: "chinese", icon: "ramen_dining", sortOrder: 40 },
  { name: "Pizza", slug: "pizza", icon: "local_pizza", sortOrder: 50 },
  { name: "Burgers", slug: "burgers", icon: "lunch_dining", sortOrder: 60 },
  { name: "Desserts", slug: "desserts", icon: "icecream", sortOrder: 70 },
  { name: "Beverages", slug: "beverages", icon: "local_cafe", sortOrder: 80 },
];

export const SEED_RESTAURANT = {
  name: "Spice Route Kitchen",
  slug: "spice-route-kitchen",
  description: "Slow-cooked biryanis, smoky tandoor dishes and comforting South Indian classics.",
  cuisines: ["Biryani", "North Indian", "South Indian"],
  phone: "9000000003",
  email: "hello@spiceroute.test",
  address: { line1: "12, 100 Feet Road", area: "Indiranagar", city: "Bengaluru", state: "Karnataka", postalCode: "560038" },
  // [longitude, latitude]
  location: { type: "Point", coordinates: [77.6412, 12.9719] },
  isPureVeg: false,
  costForTwoPaise: 50000,
  minOrderPaise: 15000,
  avgPrepTimeMinutes: 25,
  openingTime: "10:00",
  closingTime: "23:30",
  isAcceptingOrders: true,
  status: "approved",
};

const SEED_FOODS = [
  ["Hyderabadi Chicken Biryani", "biryani", 32900, false, "Long-grain basmati layered with spiced chicken, cooked dum style."],
  ["Paneer Tikka Biryani", "biryani", 28900, true, "Smoky paneer tikka folded into saffron rice."],
  ["Butter Chicken", "north-indian", 34900, false, "Tandoori chicken in a silky tomato and butter gravy."],
  ["Dal Makhani", "north-indian", 24900, true, "Black lentils simmered overnight with cream."],
  ["Garlic Naan", "north-indian", 6900, true, "Tandoor-baked flatbread with garlic butter."],
  ["Masala Dosa", "south-indian", 14900, true, "Crisp rice crepe with spiced potato, sambar and chutneys."],
  ["Gulab Jamun (2 pcs)", "desserts", 9900, true, "Warm milk dumplings in cardamom syrup."],
  ["Mango Lassi", "beverages", 11900, true, "Thick yoghurt smoothie with Alphonso mango."],
];

/** Idempotent: categories by slug, restaurant by owner, items by (restaurant, name). */
export async function seedCatalog() {
  for (const category of SEED_CATEGORIES) {
    await FoodCategory.updateOne({ slug: category.slug }, { $setOnInsert: { ...category, isActive: true } }, { upsert: true });
  }
  const owner = await User.findOne({ email: "restaurant@bitebox.test" });
  if (!owner) throw new Error("Seed users must exist before the catalog");

  await Restaurant.updateOne({ owner: owner._id }, { $setOnInsert: { ...SEED_RESTAURANT, owner: owner._id, reviewedAt: new Date() } }, { upsert: true, runValidators: true });
  const restaurant = await Restaurant.findOne({ owner: owner._id });

  const categories = new Map((await FoodCategory.find({ slug: { $in: SEED_CATEGORIES.map((c) => c.slug) } })).map((c) => [c.slug, c._id]));
  let created = 0;
  for (const [name, slug, pricePaise, isVeg, description] of SEED_FOODS) {
    const result = await FoodItem.updateOne(
      { restaurant: restaurant._id, name, deletedAt: null },
      { $setOnInsert: { restaurant: restaurant._id, name, category: categories.get(slug), pricePaise, isVeg, description, isAvailable: true } },
      { upsert: true, runValidators: true },
    );
    created += result.upsertedCount;
  }
  return { restaurant: restaurant.name, categories: categories.size, foodItemsCreated: created };
}

export const SEED_COUPONS = [
  {
    code: "WELCOME50",
    description: "50% off up to ₹100 on orders above ₹199",
    discountType: "percent",
    discountValue: 50,
    maxDiscountPaise: 10000,
    minOrderPaise: 19900,
    perUserLimit: 1,
  },
  {
    code: "FLAT75",
    description: "₹75 off on orders above ₹399",
    discountType: "flat",
    discountValue: 7500,
    minOrderPaise: 39900,
    perUserLimit: 3,
  },
];

/** Idempotent: coupons by code; the customer's address only if they have none. */
export async function seedCheckoutData() {
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 86_400_000);
  for (const coupon of SEED_COUPONS) {
    await Coupon.updateOne(
      { code: coupon.code },
      { $setOnInsert: { ...coupon, validFrom: now, validUntil: oneYear, isActive: true, usedCount: 0, usageLimit: null } },
      { upsert: true },
    );
  }
  const customer = await User.findOne({ email: "customer@bitebox.test" });
  let addressCreated = false;
  if (customer && !(await Address.exists({ user: customer._id }))) {
    await Address.create({
      user: customer._id,
      label: "home",
      recipientName: customer.name,
      phone: customer.phone ?? "9000000002",
      line1: "Flat 4B, 80 Feet Road",
      area: "Koramangala 4th Block",
      landmark: "Near Forum Mall",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560034",
      // ~4 km from the seeded restaurant: [longitude, latitude]
      location: { type: "Point", coordinates: [77.6271, 12.9352] },
      isDefault: true,
    });
    addressCreated = true;
  }
  return { coupons: SEED_COUPONS.map((c) => c.code).join(", "), customerAddressCreated: addressCreated };
}

/** Idempotent: gives the seeded rider a vehicle so they can go online (offline until they do). */
export async function seedDeliveryData() {
  const rider = await User.findOne({ email: "rider@bitebox.test" });
  if (!rider) return { riderProfileCreated: false };
  const result = await DeliveryPartner.updateOne(
    { user: rider._id },
    { $setOnInsert: { user: rider._id, vehicleType: "motorbike", vehicleNumber: "KA 01 BB 0004", isOnline: false } },
    { upsert: true },
  );
  return { riderProfileCreated: result.upsertedCount === 1 };
}

async function main() {
  if (env.isProduction) {
    console.error("Refusing to seed: NODE_ENV is production.");
    process.exit(1);
  }
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.error("Set SEED_PASSWORD (8+ chars, a letter and a number) in backend/.env or the environment.");
    process.exit(1);
  }

  await connectDB(env.mongoUri);
  try {
    const results = await seedUsers(password, { resetPasswords: process.argv.includes("--reset-passwords") });
    console.table(results);
    console.table([await seedCatalog()]);
    console.table([await seedCheckoutData()]);
    console.table([await seedDeliveryData()]);
    console.log("Development-only accounts. All use the SEED_PASSWORD value. Never use these in production.");
  } finally {
    await disconnectDB();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
