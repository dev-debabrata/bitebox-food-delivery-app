import { Router } from "express";
import { body, query } from "express-validator";
import { PERMISSIONS } from "../config/permissions.js";
import { authenticate, can } from "../middleware/auth.middleware.js";
import { CHANNELS, DELIVERY_STATUS } from "../models/notification-delivery.model.js";
import { audited } from "../services/audit.service.js";
import { PUSH_CATEGORIES } from "../services/push.service.js";
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
  // Every channel's switches per category (push, email, SMS).
  .get("/preferences", respond((req) => notifications.channelPreferences(req.user._id)))
  .put(
    "/preferences",
    validate(
      ["push", "email", "sms"].flatMap((channel) =>
        PUSH_CATEGORIES.map((c) =>
          body(`${channel}.${c}`)
            .optional()
            .isBoolean({ strict: true })
            .withMessage(`${c} must be true or false`),
        ),
      ),
    ),
    respond(
      (req) => notifications.updateChannelPreferences(req.user._id, req.body),
      "Notification preferences saved",
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

/** /api/v1/admin/notifications: the delivery log (failures, dead letters) and retries. */
export const adminNotificationsRouter = Router()
  .use(authenticate, can(PERMISSIONS.OPERATIONS_VIEW))
  .get(
    "/deliveries",
    validate([
      query("status").optional().isIn(Object.values(DELIVERY_STATUS)),
      query("channel").optional().isIn(Object.values(CHANNELS)),
      ...paginationRules,
    ]),
    respond((req) =>
      notifications.adminDeliveries(req.validatedQuery, parsePagination(req.validatedQuery)),
    ),
  )
  .post(
    "/deliveries/:id/retry",
    validate([mongoIdParam()]),
    audited("notification.retry", "notification_delivery", () => "Retried a notification"),
    respond((req) => notifications.adminRetry(req.params.id), "Sending again"),
  );
