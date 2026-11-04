import { Router } from "express";
import { body, query } from "express-validator";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { Session } from "../models/session.model.js";
import { ALL_ROLES, ROLES, User, USER_STATUS } from "../models/user.model.js";
import { adminSetStatus } from "../services/delivery-partner.service.js";
import { ApiError } from "../utils/api-error.js";
import { sendSuccess } from "../utils/api-response.js";
import {
  escapeRegex,
  paginationMeta,
  parsePagination,
} from "../utils/pagination.js";
import { mongoIdParam } from "../validators/common.validators.js";

const router = Router();

router.use(authenticate, authorize(ROLES.ADMIN));

/** GET /api/v1/admin/users?role=&status=&search=&page=&limit= */
router.get(
  "/",
  validate([
    query("role").optional().isIn(ALL_ROLES),
    query("status").optional().isIn(Object.values(USER_STATUS)),
    query("search").optional().isString().trim().isLength({ max: 100 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ]),
  async (req, res) => {
    const { role, status, search } = req.validatedQuery;
    const pagination = parsePagination(req.validatedQuery);

    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      User.countDocuments(filter),
    ]);

    sendSuccess(res, {
      data: {
        items: items.map((u) => u.toJSON()),
        pagination: paginationMeta(pagination, total),
      },
    });
  },
);

/** PATCH /api/v1/admin/users/:id/status */
router.patch(
  "/:id/status",
  validate([
    mongoIdParam(),
    body("status")
      .isIn(Object.values(USER_STATUS))
      .withMessage(`Status must be one of: ${Object.values(USER_STATUS).join(", ")}`),
  ]),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (String(req.user._id) === String(id)) {
      throw ApiError.badRequest("You cannot suspend your own account");
    }

    const user = await User.findById(id).select("+tokenVersion");
    if (!user) throw ApiError.notFound("User not found");

    if (user.role === ROLES.DELIVERY) {
      const updated = await adminSetStatus(user._id, status);
      return sendSuccess(res, {
        data: { user: updated },
        message: status === USER_STATUS.ACTIVE ? "User reactivated" : "User suspended",
      });
    }

    user.status = status;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await Session.updateMany(
      { user: user._id, revokedAt: null },
      {
        revokedAt: new Date(),
        revokedReason: status === USER_STATUS.SUSPENDED ? "suspended" : "logout",
      },
    );

    sendSuccess(res, {
      data: { user: user.toJSON() },
      message: status === USER_STATUS.ACTIVE ? "User reactivated" : "User suspended",
    });
  },
);

export default router;
