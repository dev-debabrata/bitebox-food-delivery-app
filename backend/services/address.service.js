import { Address, MAX_ADDRESSES_PER_USER } from "../models/address.model.js";
import { toPoint } from "../utils/geo.js";
import { ApiError } from "../utils/api-error.js";

const FIELDS = [
  "label",
  "recipientName",
  "phone",
  "line1",
  "line2",
  "area",
  "landmark",
  "city",
  "state",
  "postalCode",
];
const pick = (source) =>
  Object.fromEntries(
    FIELDS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );

export const list = (userId) =>
  Address.find({ user: userId }).sort({ isDefault: -1, updatedAt: -1 });

/** Every query is scoped by user, so customers can only see/modify their own addresses. */
export async function getOwn(userId, id, session = null) {
  const address = await Address.findOne({ _id: id, user: userId }).session(
    session,
  );
  if (!address) throw ApiError.notFound("Address not found");
  return address;
}

export async function create(userId, input) {
  const count = await Address.countDocuments({ user: userId });
  if (count >= MAX_ADDRESSES_PER_USER)
    throw ApiError.conflict(
      `You can save up to ${MAX_ADDRESSES_PER_USER} addresses`,
    );
  const makeDefault = count === 0 || input.isDefault === true;
  if (makeDefault)
    await Address.updateMany({ user: userId }, { isDefault: false });
  return Address.create({
    ...pick(input),
    location: toPoint(input.location),
    user: userId,
    isDefault: makeDefault,
  });
}

export async function update(userId, id, input) {
  const address = await getOwn(userId, id);
  Object.assign(address, pick(input));
  if (input.location) address.location = toPoint(input.location);
  await address.save();
  if (input.isDefault === true) return setDefault(userId, id);
  return address;
}

export async function setDefault(userId, id) {
  const address = await getOwn(userId, id);
  await Address.updateMany(
    { user: userId, _id: { $ne: address._id } },
    { isDefault: false },
  );
  address.isDefault = true;
  return address.save();
}

/** Deleting the default address promotes the most recently used remaining one. */
export async function remove(userId, id) {
  const address = await getOwn(userId, id);
  await address.deleteOne();
  if (address.isDefault) {
    const next = await Address.findOne({ user: userId }).sort({
      updatedAt: -1,
    });
    if (next) await Address.updateOne({ _id: next._id }, { isDefault: true });
  }
}
