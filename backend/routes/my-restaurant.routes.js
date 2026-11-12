import { Router } from "express";
import * as foods from "../controllers/food.controller.js";
import * as orders from "../controllers/order-management.controller.js";
import * as restaurants from "../controllers/restaurant.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as foodRules from "../validators/food.validators.js";
import * as reports from "../services/reports.service.js";
import * as reviews from "../services/review.service.js";
import * as reviewRules from "../validators/review.validators.js";
import { parsePagination } from "../utils/pagination.js";
import { respond } from "../utils/api-response.js";
import * as orderRules from "../validators/order-management.validators.js";
import { daysRules } from "../validators/payment.validators.js";
import * as restaurantRules from "../validators/restaurant.validators.js";

const router = Router();
router.use(authenticate, authorize(ROLES.RESTAURANT));

router.get("/", restaurants.getMine);
router.post(
  "/",
  validate(restaurantRules.createRestaurantRules),
  restaurants.createMine,
);
router.patch(
  "/",
  validate(restaurantRules.updateRestaurantRules),
  restaurants.updateMine,
);
router.patch(
  "/accepting-orders",
  validate(restaurantRules.acceptingOrdersRules),
  restaurants.setAcceptingOrders,
);

router.get("/foods", validate(foodRules.ownerListRules), foods.ownerList);
router.post("/foods", validate(foodRules.createFoodRules), foods.ownerCreate);
router.patch(
  "/foods/:id",
  validate(foodRules.updateFoodRules),
  foods.ownerUpdate,
);
router.patch(
  "/foods/:id/availability",
  validate(foodRules.availabilityRules),
  foods.ownerSetAvailability,
);
router.delete("/foods/:id", validate([mongoIdParam()]), foods.ownerDelete);

router.get("/stats", orders.restaurantStats);
router.get(
  "/orders",
  validate(orderRules.restaurantListRules),
  orders.restaurantList,
);
router.get(
  "/earnings",
  validate(daysRules),
  respond((req) =>
    reports.restaurantEarnings(req.user._id, req.validatedQuery.days ?? 30),
  ),
);
router.get("/orders/:id", validate([mongoIdParam()]), orders.restaurantGet);

router.get(
  "/reviews/orders",
  validate(reviewRules.restaurantListRules),
  respond((req) =>
    reviews.restaurantOrders(
      req.user._id,
      req.validatedQuery,
      parsePagination(req.validatedQuery, { defaultLimit: 10 }),
    ),
  ),
);
router.get(
  "/reviews/orders/:orderId",
  validate([mongoIdParam("orderId")]),
  respond((req) => reviews.restaurantOrder(req.user._id, req.params.orderId)),
);
router.get(
  "/reviews/summary",
  respond((req) => reviews.restaurantSummary(req.user._id)),
);
router.put(
  "/reviews/:id/response",
  validate(reviewRules.responseRules),
  respond(
    async (req) => ({
      review: await reviews.respond(req.user._id, req.params.id, req.body.text),
    }),
    "Reply posted",
  ),
);
router.delete(
  "/reviews/:id/response",
  validate([mongoIdParam()]),
  respond(
    async (req) => ({
      review: await reviews.deleteResponse(req.user._id, req.params.id),
    }),
    "Reply removed",
  ),
);
router.patch(
  "/orders/:id/status",
  validate(orderRules.restaurantStatusRules),
  orders.restaurantSetStatus,
);

export default router;
