import * as riders from "../services/delivery-partner.service.js";
import * as dispatch from "../services/dispatch.service.js";
import * as orders from "../services/order-management.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const STATUS_MESSAGE = {
  confirmed: "Order accepted",
  rejected: "Order rejected",
  preparing: "Marked as preparing",
  ready_for_pickup: "Marked ready for pickup",
  arrived_at_restaurant: "Marked as arrived. Collect the order when it is ready.",
  picked_up: "Marked as picked up",
  on_the_way: "On the way",
  delivered: "Delivered. Nice work!",
};
const statusMessage = (req) => STATUS_MESSAGE[req.body.status];
const page = (req) => parsePagination(req.validatedQuery);
const asOrder = (order) => ({ order });

// Customer
export const customerGet = respond(async (req) =>
  asOrder(await orders.customerGet(req.user._id, req.params.id)),
);
export const customerCancel = respond(
  async (req) =>
    asOrder(
      await orders.customerCancel(req.user._id, req.params.id, req.body.reason),
    ),
  "Order cancelled",
);

// Restaurant
export const restaurantList = respond((req) =>
  orders.restaurantList(req.user._id, req.validatedQuery, page(req)),
);
export const restaurantGet = respond(async (req) =>
  asOrder(await orders.restaurantGet(req.user._id, req.params.id)),
);
export const restaurantSetStatus = respond(
  async (req) =>
    asOrder(
      await orders.restaurantSetStatus(req.user._id, req.params.id, req.body),
    ),
  statusMessage,
);

// Rider: actions answer with the fresh dashboard (offer + active order) so the app needs no second call.
export const riderDashboard = respond((req) => riders.dashboard(req.user._id));
export const riderUpdateVehicle = respond(
  async (req) => ({
    profile: await riders.updateVehicle(req.user._id, req.body),
  }),
  "Vehicle saved",
);
export const riderSetAvailability = respond(
  (req) => riders.setAvailability(req.user._id, req.body),
  (req) => (req.body.isOnline ? "You are online" : "You are offline"),
);
export const riderUpdateLocation = respond((req) =>
  riders.updateLocation(req.user._id, req.body),
);
export const riderAcceptOffer = respond(async (req) => {
  await dispatch.acceptOffer(req.user._id, req.params.id);
  return riders.dashboard(req.user._id);
}, "Delivery accepted. Head to the restaurant.");
export const riderDeclineOffer = respond(async (req) => {
  await dispatch.declineOffer(req.user._id, req.params.id);
  return riders.dashboard(req.user._id);
}, "Request declined");
export const riderSetStatus = respond(async (req) => {
  await orders.riderSetStatus(
    req.user._id,
    req.params.id,
    req.body.status,
    req.body.otp,
  );
  return riders.dashboard(req.user._id);
}, statusMessage);
export const riderHistory = respond((req) =>
  orders.riderHistory(req.user._id, page(req)),
);

// Admin
export const adminList = respond((req) =>
  orders.adminList(req.validatedQuery, page(req)),
);
export const adminGet = respond(async (req) =>
  asOrder(await orders.adminGet(req.params.id)),
);
export const adminCancel = respond(
  async (req) =>
    asOrder(
      await orders.adminCancel(req.user._id, req.params.id, req.body.reason),
    ),
  "Order cancelled",
);
export const adminUnassign = respond(
  async (req) =>
    asOrder(
      await orders.adminUnassign(req.user._id, req.params.id, req.body.reason),
    ),
  "Rider unassigned; looking for another rider",
);
export const adminAssign = respond(
  async (req) =>
    asOrder(await orders.adminAssign(req.user._id, req.params.id, req.body.riderId)),
  "Rider assigned",
);
export const adminResetDeliveryOtp = respond(
  async (req) => asOrder(await orders.adminResetDeliveryOtp(req.params.id)),
  "New delivery code sent to the customer",
);
export const customerTimeline = respond((req) =>
  orders.customerTimeline(req.user._id, req.params.id),
);
export const adminTimeline = respond((req) => orders.adminTimeline(req.params.id));
export const restaurantStats = respond((req) => orders.restaurantStats(req.user._id));
export const adminRiderList = respond((req) =>
  riders.adminList(req.validatedQuery, page(req)),
);
export const adminRiderGet = respond((req) => riders.adminGet(req.params.id));
export const adminRiderSetVerification = respond(
  (req) => riders.adminSetVerification(req.params.id, req.body.status, req.body.reason ?? "", req.user._id),
  "Verification updated",
);
export const riderUpdateDetails = respond(
  async (req) => ({ profile: await riders.updateDetails(req.user._id, req.body.address) }),
  "Details saved",
);
export const riderResubmit = respond(
  async (req) => ({ profile: await riders.resubmit(req.user) }),
  "Sent for review",
);

export const adminRiderSetStatus = respond(
  async (req) => ({
    user: await riders.adminSetStatus(req.params.id, req.body.status),
  }),
  (_req, data) =>
    data.user.status === "active" ? "Rider reactivated" : "Rider suspended",
);
