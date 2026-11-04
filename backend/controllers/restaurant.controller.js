import * as foodService from "../services/food.service.js";
import * as restaurantService from "../services/restaurant.service.js";
import { sendSuccess } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";

// Public
export async function listPublic(req, res) {
  const data = await restaurantService.listPublic(
    req.validatedQuery,
    parsePagination(req.validatedQuery, { defaultLimit: 12 }),
  );
  sendSuccess(res, { data });
}

export async function listCuisines(_req, res) {
  sendSuccess(res, {
    data: { cuisines: await restaurantService.listCuisines() },
  });
}

export async function getPublic(req, res) {
  const restaurant = await restaurantService.getPublicBySlugOrId(
    req.params.slugOrId,
  );
  sendSuccess(res, {
    data: { restaurant: restaurantService.publicView(restaurant) },
  });
}

export async function getPublicMenu(req, res) {
  const restaurant = await restaurantService.getPublicBySlugOrId(
    req.params.slugOrId,
  );
  sendSuccess(res, {
    data: { sections: await foodService.publicMenu(restaurant._id) },
  });
}

// Owner: the restaurant is always resolved from the signed-in user, never from
// a client-supplied id.
export async function getMine(req, res) {
  const restaurant = await restaurantService.getOwnRestaurant(req.user._id);
  const stats = restaurant
    ? await restaurantService.ownerStats(restaurant._id)
    : null;
  sendSuccess(res, {
    data: { restaurant: restaurant?.toJSON() ?? null, stats },
  });
}

export async function createMine(req, res) {
  const restaurant = await restaurantService.createOwnRestaurant(
    req.user._id,
    req.body,
  );
  sendSuccess(res, {
    statusCode: 201,
    message: "Restaurant submitted for approval",
    data: { restaurant: restaurant.toJSON() },
  });
}

export async function updateMine(req, res) {
  const restaurant = await restaurantService.updateOwnRestaurant(
    req.user._id,
    req.body,
  );
  sendSuccess(res, {
    message: "Restaurant details saved",
    data: { restaurant: restaurant.toJSON() },
  });
}

export async function setAcceptingOrders(req, res) {
  const restaurant = await restaurantService.setAcceptingOrders(
    req.user._id,
    req.body.isAcceptingOrders,
  );
  sendSuccess(res, {
    message: restaurant.isAcceptingOrders
      ? "You are accepting orders"
      : "Orders paused",
    data: { restaurant: restaurant.toJSON() },
  });
}

// Admin
export async function adminList(req, res) {
  const data = await restaurantService.adminList(
    req.validatedQuery,
    parsePagination(req.validatedQuery),
  );
  sendSuccess(res, {
    data: { ...data, items: data.items.map((r) => r.toJSON()) },
  });
}

export async function adminCounts(_req, res) {
  sendSuccess(res, { data: { counts: await restaurantService.adminCounts() } });
}

export async function adminGet(req, res) {
  const restaurant = await restaurantService.adminGet(req.params.id);
  sendSuccess(res, {
    data: {
      restaurant: restaurant.toJSON(),
      stats: await restaurantService.ownerStats(restaurant._id),
    },
  });
}

export async function adminSetStatus(req, res) {
  const restaurant = await restaurantService.adminSetStatus(
    req.params.id,
    req.body.status,
    req.body.reason,
    req.user._id,
  );
  sendSuccess(res, {
    message: `Restaurant ${restaurant.status}`,
    data: { restaurant: restaurant.toJSON() },
  });
}
