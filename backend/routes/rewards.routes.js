import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ROLES } from "../models/user.model.js";
import * as special from "../services/special-rewards.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import { mongoIdParam } from "../validators/common.validators.js";
import * as rules from "../validators/rewards.validators.js";

/** /api/v1/rewards: the customer's special rewards (birthday, welcome, campaigns). */
export const rewardsRouter = Router()
  .use(authenticate, authorize(ROLES.CUSTOMER))
  .get("/", respond((req) => special.overview(req.user._id)))
  .get("/campaigns", respond((req) => special.customerCampaigns(req.user._id)))
  .post(
    "/campaigns/:id/claim",
    validate([mongoIdParam()]),
    respond((req) => special.claim(req.user._id, req.params.id), "Reward claimed", 201),
  )
  .get(
    "/history",
    validate(rules.rewardHistoryRules),
    respond((req) =>
      special.history(req.user._id, req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .put(
    "/birthday",
    validate(rules.birthdayRules),
    respond((req) => special.setBirthDate(req.user._id, req.body.birthDate), "Birthday saved"),
  );
