import { DeliveryPartner } from "../models/delivery-partner.model.js";
import { ORDER_STATUS, Order } from "../models/order.model.js";
import { ROLES, User, USER_STATUS } from "../models/user.model.js";
import { ApiError } from "../utils/api-error.js";
import { toPoint } from "../utils/geo.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import {
  declineOffer,
  dispatchSafely,
  findWaitingOrders,
} from "./dispatch.service.js";
import { presentForRider } from "./order-management.service.js";

/** The rider's profile, created on first use (a plain read on every later call). */
export async function getOrCreateProfile(userId) {
  return (
    (await DeliveryPartner.findOne({ user: userId })) ??
    DeliveryPartner.findOneAndUpdate(
      { user: userId },
      { $setOnInsert: { user: userId } },
      { upsert: true, returnDocument: "after" },
    )
  );
}

/** Profile + the offer waiting for them + the order they are carrying: everything the dashboard needs. */
export async function dashboard(userId) {
  const profile = await getOrCreateProfile(userId);
  const [offer, active] = await Promise.all([
    profile.currentOffer
      ? Order.findOne({
          _id: profile.currentOffer,
          status: ORDER_STATUS.READY_FOR_PICKUP,
          "offer.partner": userId,
        })
      : null,
    profile.activeOrder
      ? Order.findOne({ _id: profile.activeOrder, deliveryPartner: userId })
      : null,
  ]);
  return {
    profile: profile.toJSON(),
    offer: offer ? presentForRider(offer, userId) : null,
    activeOrder: active ? presentForRider(active, userId) : null,
  };
}

export async function updateVehicle(userId, { vehicleType, vehicleNumber }) {
  return DeliveryPartner.findOneAndUpdate(
    { user: userId },
    { $set: { vehicleType, vehicleNumber } },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
}

export async function setAvailability(
  userId,
  { isOnline, latitude, longitude },
) {
  const profile = await getOrCreateProfile(userId);
  if (isOnline) {
    if (!profile.vehicleType)
      throw ApiError.badRequest("Add your vehicle details before going online");
    if (latitude === undefined || longitude === undefined)
      throw ApiError.badRequest("Share your location to go online");
    await DeliveryPartner.updateOne(
      { user: userId },
      {
        $set: {
          isOnline: true,
          location: toPoint({ latitude, longitude }),
          locationUpdatedAt: new Date(),
        },
      },
    );
    await offerWaitingOrders();
    return dashboard(userId);
  }

  await takeOffline(
    userId,
    profile,
    "Finish your current delivery before going offline",
  );
  return dashboard(userId);
}

/** Offline rules shared by the rider and admins: never mid-delivery; a pending offer is passed on. */
async function takeOffline(userId, profile, busyMessage) {
  if (profile?.activeOrder)
    throw new ApiError(409, busyMessage, { code: "DELIVERY_IN_PROGRESS" });
  if (profile?.currentOffer)
    await declineOffer(userId, profile.currentOffer).catch(() => undefined);
  await DeliveryPartner.updateOne(
    { user: userId },
    { $set: { isOnline: false } },
  );
}

/** Position report from the rider's device (rate limited at the route). */
export async function updateLocation(userId, { latitude, longitude }) {
  const updated = await DeliveryPartner.findOneAndUpdate(
    { user: userId, isOnline: true },
    {
      $set: {
        location: toPoint({ latitude, longitude }),
        locationUpdatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated)
    throw new ApiError(409, "Go online to share your location", {
      code: "OFFLINE",
    });
  return { locationUpdatedAt: updated.locationUpdatedAt };
}

/** A rider just became available: give waiting orders a chance straight away. */
async function offerWaitingOrders() {
  for (const order of await findWaitingOrders(5)) {
    if (await dispatchSafely(order._id)) break; // one offer per rider at a time
  }
}

// Admin
export async function adminList({ search, online }, pagination) {
  const userFilter = { role: ROLES.DELIVERY };
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    userFilter.$or = [
      { name: pattern },
      { email: pattern },
      { phone: pattern },
    ];
  }
  if (online === true) {
    const onlineIds = await DeliveryPartner.find({ isOnline: true }).distinct(
      "user",
    );
    userFilter._id = { $in: onlineIds };
  }
  const [users, total] = await Promise.all([
    User.find(userFilter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    User.countDocuments(userFilter),
  ]);
  const profiles = await DeliveryPartner.find({
    user: { $in: users.map((u) => u._id) },
  });
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  const activeOrders = await Order.find({
    _id: { $in: profiles.map((p) => p.activeOrder).filter(Boolean) },
  }).select("orderNumber status");
  const orderById = new Map(activeOrders.map((o) => [String(o._id), o]));

  const items = users.map((u) => {
    const p = byUser.get(String(u._id));
    const active = p?.activeOrder ? orderById.get(String(p.activeOrder)) : null;
    return {
      ...u.toJSON(),
      vehicleType: p?.vehicleType ?? null,
      vehicleNumber: p?.vehicleNumber ?? null,
      isOnline: p?.isOnline ?? false,
      locationUpdatedAt: p?.locationUpdatedAt ?? null,
      completedDeliveries: p?.completedDeliveries ?? 0,
      rating: p?.rating ?? null,
      activeOrder: active
        ? {
            id: String(active._id),
            orderNumber: active.orderNumber,
            status: active.status,
          }
        : null,
    };
  });
  return { items, pagination: paginationMeta(pagination, total) };
}

/** Suspend or reactivate a rider. Suspending takes them offline; not allowed mid-delivery. */
export async function adminSetStatus(userId, status) {
  const user = await User.findOne({ _id: userId, role: ROLES.DELIVERY });
  if (!user) throw ApiError.notFound("Delivery partner not found");
  if (status === USER_STATUS.SUSPENDED) {
    const profile = await DeliveryPartner.findOne({ user: userId });
    await takeOffline(
      userId,
      profile,
      "This rider is carrying an order. Unassign or finish it first.",
    );
  }
  user.status = status;
  await user.save();
  return user.toJSON();
}
