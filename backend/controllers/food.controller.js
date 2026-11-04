import * as foodService from "../services/food.service.js";
import { requireOwnRestaurant } from "../services/restaurant.service.js";
import { sendSuccess } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

const json = (data) => ({ ...data, items: data.items.map((i) => i.toJSON()) });

// Owner menu management, always scoped to the caller's own restaurant.
export async function ownerList(req, res) {
  const restaurant = await requireOwnRestaurant(req.user._id);
  const data = await foodService.ownerList(
    restaurant._id,
    req.validatedQuery,
    parsePagination(req.validatedQuery, { defaultLimit: 50 }),
  );
  sendSuccess(res, { data: json(data) });
}

export async function ownerCreate(req, res) {
  const restaurant = await requireOwnRestaurant(req.user._id);
  const item = await foodService.ownerCreate(restaurant._id, req.body);
  sendSuccess(res, {
    statusCode: 201,
    message: "Menu item added",
    data: { item: item.toJSON() },
  });
}

export async function ownerUpdate(req, res) {
  const restaurant = await requireOwnRestaurant(req.user._id);
  const item = await foodService.ownerUpdate(
    restaurant._id,
    req.params.id,
    req.body,
  );
  sendSuccess(res, {
    message: "Menu item saved",
    data: { item: item.toJSON() },
  });
}

export async function ownerSetAvailability(req, res) {
  const restaurant = await requireOwnRestaurant(req.user._id);
  const item = await foodService.ownerSetAvailability(
    restaurant._id,
    req.params.id,
    req.body.isAvailable,
  );
  sendSuccess(res, {
    message: item.isAvailable ? "Item is available" : "Item marked unavailable",
    data: { item: item.toJSON() },
  });
}

export async function ownerDelete(req, res) {
  const restaurant = await requireOwnRestaurant(req.user._id);
  await foodService.ownerDelete(restaurant._id, req.params.id);
  sendSuccess(res, { message: "Menu item deleted" });
}

// Admin
export async function adminList(req, res) {
  const data = await foodService.adminList(
    req.validatedQuery,
    parsePagination(req.validatedQuery),
  );
  sendSuccess(res, { data: json(data) });
}

export async function adminSetAvailability(req, res) {
  const item = await foodService.adminSetAvailability(
    req.params.id,
    req.body.isAvailable,
  );
  sendSuccess(res, {
    message: "Availability updated",
    data: { item: item.toJSON() },
  });
}

export async function adminDelete(req, res) {
  await foodService.adminDelete(req.params.id);
  sendSuccess(res, { message: "Menu item deleted" });
}

// Public
export async function publicSearch(req, res) {
  const data = await foodService.publicSearch(
    req.validatedQuery,
    parsePagination(req.validatedQuery, { defaultLimit: 12 }),
  );
  sendSuccess(res, { data });
}

export async function publicGet(req, res) {
  sendSuccess(res, {
    data: { item: await foodService.publicGet(req.params.id) },
  });
}
