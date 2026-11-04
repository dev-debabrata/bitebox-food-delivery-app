import { Router } from "express";
import { param } from "express-validator";
import * as categories from "../controllers/category.controller.js";
import * as foods from "../controllers/food.controller.js";
import * as restaurants from "../controllers/restaurant.controller.js";
import { validate } from "../middleware/validate.middleware.js";
import { getPublicBySlugOrId } from "../services/restaurant.service.js";
import * as reviews from "../services/review.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { mongoIdParam } from "../validators/common.validators.js";
import { publicSearchRules } from "../validators/food.validators.js";
import { publicListRules } from "../validators/restaurant.validators.js";
import * as reviewRules from "../validators/review.validators.js";

const reviewPage = (req) =>
  parsePagination(req.validatedQuery, { defaultLimit: 10, maxLimit: 50 });

const slugOrId = param("slugOrId")
  .isString()
  .trim()
  .isLength({ min: 1, max: 80 })
  .matches(/^[a-z0-9-]+$/i);

export const restaurantsRouter = Router()
  .get("/", validate(publicListRules), restaurants.listPublic)
  .get("/cuisines", restaurants.listCuisines)
  .get("/:slugOrId", validate([slugOrId]), restaurants.getPublic)
  .get("/:slugOrId/menu", validate([slugOrId]), restaurants.getPublicMenu)
  .get(
    "/:slugOrId/reviews",
    validate([slugOrId, ...reviewRules.publicListRules]),
    respond(async (req) => {
      const restaurant = await getPublicBySlugOrId(req.params.slugOrId);
      return reviews.publicRestaurantReviews(
        restaurant,
        req.validatedQuery,
        reviewPage(req),
      );
    }),
  );

export const categoriesRouter = Router().get("/", categories.listActive);

export const foodsRouter = Router()
  .get("/", validate(publicSearchRules), foods.publicSearch)
  .get("/:id", validate([mongoIdParam()]), foods.publicGet)
  .get(
    "/:id/reviews",
    validate(reviewRules.publicFoodListRules),
    respond((req) =>
      reviews.publicFoodReviews(
        req.params.id,
        req.validatedQuery,
        reviewPage(req),
      ),
    ),
  );
