import { Router } from "express";
import * as categories from "../controllers/category.controller.js";
import * as foods from "../controllers/food.controller.js";
import * as restaurants from "../controllers/restaurant.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as categoryRules from "../validators/category.validators.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as foodRules from "../validators/food.validators.js";
import * as restaurantRules from "../validators/restaurant.validators.js";

const router = Router();
router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  "/restaurants",
  validate(restaurantRules.adminListRules),
  restaurants.adminList,
);
router.get("/restaurants/counts", restaurants.adminCounts);
router.get(
  "/restaurants/:id",
  validate([mongoIdParam()]),
  restaurants.adminGet,
);
router.patch(
  "/restaurants/:id/status",
  validate(restaurantRules.adminStatusRules),
  restaurants.adminSetStatus,
);

router.get("/categories", categories.adminList);
router.post(
  "/categories",
  validate(categoryRules.createCategoryRules),
  categories.create,
);
router.patch(
  "/categories/:id",
  validate(categoryRules.updateCategoryRules),
  categories.update,
);
router.delete("/categories/:id", validate([mongoIdParam()]), categories.remove);

router.get("/foods", validate(foodRules.adminListRules), foods.adminList);
router.patch(
  "/foods/:id/availability",
  validate(foodRules.availabilityRules),
  foods.adminSetAvailability,
);
router.delete("/foods/:id", validate([mongoIdParam()]), foods.adminDelete);

export default router;
