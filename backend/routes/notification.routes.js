import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import * as notifications from "../services/notification.service.js";
import { respond } from "../utils/api-response.js";
import { parsePagination } from "../utils/pagination.js";
import {
  booleanQuery,
  mongoIdParam,
  paginationRules,
} from "../validators/common.validators.js";

export default Router()
  .use(authenticate)
  .get(
    "/",
    validate([...paginationRules, booleanQuery("unread")]),
    respond((req) =>
      notifications.list(req.user._id, parsePagination(req.validatedQuery), {
        unreadOnly: req.validatedQuery.unread === true,
      }),
    ),
  )
  .delete(
    "/",
    respond(
      (req) => notifications.clearAll(req.user._id),
      "Notifications cleared",
    ),
  )
  .post(
    "/read-all",
    respond((req) => notifications.markAllRead(req.user._id), "All caught up"),
  )
  .patch(
    "/:id/read",
    validate([mongoIdParam()]),
    respond(async (req) => ({
      notification: await notifications.markRead(req.user._id, req.params.id),
    })),
  );
