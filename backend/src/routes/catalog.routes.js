import { Router } from "express";
import { param } from "express-validator";
import * as categories from "../controllers/category.controller.js";
import * as foods from "../controllers/food.controller.js";
import * as restaurants from "../controllers/restaurant.controller.js";
import { validate } from "../middleware/validate.middleware.js";
import { mongoIdParam } from "../validators/common.validators.js";
import { publicSearchRules } from "../validators/food.validators.js";
import { publicListRules } from "../validators/restaurant.validators.js";

/** Public, unauthenticated catalogue: only approved restaurants are ever exposed. */
const slugOrId = param("slugOrId").isString().trim().isLength({ min: 1, max: 80 }).matches(/^[a-z0-9-]+$/i);

export const restaurantsRouter = Router()
  .get("/", validate(publicListRules), restaurants.listPublic)
  .get("/cuisines", restaurants.listCuisines)
  .get("/:slugOrId", validate([slugOrId]), restaurants.getPublic)
  .get("/:slugOrId/menu", validate([slugOrId]), restaurants.getPublicMenu);

export const categoriesRouter = Router().get("/", categories.listActive);

export const foodsRouter = Router()
  .get("/", validate(publicSearchRules), foods.publicSearch)
  .get("/:id", validate([mongoIdParam()]), foods.publicGet);
