import { Router } from "express";
import * as categories from "../controllers/category.controller.js";
import * as foods from "../controllers/food.controller.js";
import * as restaurants from "../controllers/restaurant.controller.js";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { audited } from "../services/audit.service.js";
import * as categoryRules from "../validators/category.validators.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as foodRules from "../validators/food.validators.js";
import * as restaurantRules from "../validators/restaurant.validators.js";

const router = Router();
const P = PERMISSIONS;
const restaurantsOnly = can(P.RESTAURANTS_MANAGE);
const catalogOnly = can(P.CATALOG_MANAGE);
router.use(authenticate);

router.get(
  "/restaurants",
  restaurantsOnly,
  validate(restaurantRules.adminListRules),
  restaurants.adminList,
);
router.get("/restaurants/counts", restaurantsOnly, restaurants.adminCounts);
router.get(
  "/restaurants/:id",
  restaurantsOnly,
  validate([mongoIdParam()]),
  restaurants.adminGet,
);
router.patch(
  "/restaurants/:id/status",
  restaurantsOnly,
  validate(restaurantRules.adminStatusRules),
  audited("restaurant.status", "restaurant", (req) =>
    [`Set restaurant status to ${req.body.status}`, req.body.reason].filter(Boolean).join(": "),
  ),
  restaurants.adminSetStatus,
);

router.get("/categories", catalogOnly, categories.adminList);
router.post(
  "/categories",
  catalogOnly,
  validate(categoryRules.createCategoryRules),
  categories.create,
);
router.patch(
  "/categories/:id",
  catalogOnly,
  validate(categoryRules.updateCategoryRules),
  categories.update,
);
router.delete(
  "/categories/:id",
  catalogOnly,
  validate([mongoIdParam()]),
  audited("category.delete", "category", () => "Deleted food category"),
  categories.remove,
);

router.get("/foods", restaurantsOnly, validate(foodRules.adminListRules), foods.adminList);
router.patch(
  "/foods/:id/availability",
  restaurantsOnly,
  validate(foodRules.availabilityRules),
  foods.adminSetAvailability,
);
router.delete(
  "/foods/:id",
  restaurantsOnly,
  validate([mongoIdParam()]),
  audited("food.delete", "food", () => "Deleted menu item"),
  foods.adminDelete,
);

export default router;
