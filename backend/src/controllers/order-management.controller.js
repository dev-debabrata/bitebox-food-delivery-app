import * as riders from "../services/delivery-partner.service.js";
import * as dispatch from "../services/dispatch.service.js";
import * as orders from "../services/order-management.service.js";
import { sendSuccess } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const STATUS_MESSAGE = {
  confirmed: "Order accepted",
  rejected: "Order rejected",
  preparing: "Marked as preparing",
  ready_for_pickup: "Marked ready for pickup",
  picked_up: "Marked as picked up",
  on_the_way: "On the way",
  delivered: "Delivered. Nice work!",
};

// Customer ------------------------------------------------------------------
export async function customerGet(req, res) {
  sendSuccess(res, { data: { order: await orders.customerGet(req.user._id, req.params.id) } });
}

export async function customerCancel(req, res) {
  const order = await orders.customerCancel(req.user._id, req.params.id, req.body.reason);
  sendSuccess(res, { message: "Order cancelled", data: { order } });
}

// Restaurant ----------------------------------------------------------------
export async function restaurantList(req, res) {
  const data = await orders.restaurantList(req.user._id, req.validatedQuery, parsePagination(req.validatedQuery));
  sendSuccess(res, { data });
}

export async function restaurantGet(req, res) {
  sendSuccess(res, { data: { order: await orders.restaurantGet(req.user._id, req.params.id) } });
}

export async function restaurantSetStatus(req, res) {
  const order = await orders.restaurantSetStatus(req.user._id, req.params.id, req.body);
  sendSuccess(res, { message: STATUS_MESSAGE[req.body.status], data: { order } });
}

// Rider ---------------------------------------------------------------------
export async function riderDashboard(req, res) {
  sendSuccess(res, { data: await riders.dashboard(req.user._id) });
}

export async function riderUpdateVehicle(req, res) {
  const profile = await riders.updateVehicle(req.user._id, req.body);
  sendSuccess(res, { message: "Vehicle saved", data: { profile } });
}

export async function riderSetAvailability(req, res) {
  const data = await riders.setAvailability(req.user._id, req.body);
  sendSuccess(res, { message: req.body.isOnline ? "You are online" : "You are offline", data });
}

export async function riderUpdateLocation(req, res) {
  sendSuccess(res, { data: await riders.updateLocation(req.user._id, req.body) });
}

export async function riderAcceptOffer(req, res) {
  await dispatch.acceptOffer(req.user._id, req.params.id);
  sendSuccess(res, { message: "Delivery accepted. Head to the restaurant.", data: await riders.dashboard(req.user._id) });
}

export async function riderDeclineOffer(req, res) {
  await dispatch.declineOffer(req.user._id, req.params.id);
  sendSuccess(res, { message: "Request declined", data: await riders.dashboard(req.user._id) });
}

export async function riderSetStatus(req, res) {
  await orders.riderSetStatus(req.user._id, req.params.id, req.body.status);
  sendSuccess(res, { message: STATUS_MESSAGE[req.body.status], data: await riders.dashboard(req.user._id) });
}

export async function riderHistory(req, res) {
  sendSuccess(res, { data: await orders.riderHistory(req.user._id, parsePagination(req.validatedQuery)) });
}

// Admin ---------------------------------------------------------------------
export async function adminList(req, res) {
  sendSuccess(res, { data: await orders.adminList(req.validatedQuery, parsePagination(req.validatedQuery)) });
}

export async function adminGet(req, res) {
  sendSuccess(res, { data: { order: await orders.adminGet(req.params.id) } });
}

export async function adminCancel(req, res) {
  const order = await orders.adminCancel(req.user._id, req.params.id, req.body.reason);
  sendSuccess(res, { message: "Order cancelled", data: { order } });
}

export async function adminUnassign(req, res) {
  const order = await orders.adminUnassign(req.user._id, req.params.id, req.body.reason);
  sendSuccess(res, { message: "Rider unassigned; looking for another rider", data: { order } });
}

export async function adminRiderList(req, res) {
  sendSuccess(res, { data: await riders.adminList(req.validatedQuery, parsePagination(req.validatedQuery)) });
}

export async function adminRiderSetStatus(req, res) {
  const user = await riders.adminSetStatus(req.params.id, req.body.status);
  sendSuccess(res, { message: user.status === "active" ? "Rider reactivated" : "Rider suspended", data: { user } });
}
