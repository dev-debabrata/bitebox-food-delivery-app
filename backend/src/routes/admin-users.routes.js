import { Router } from "express";
import { query } from "express-validator";
import { authenticate, authorize } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { ALL_ROLES, ROLES, User, USER_STATUS } from "../models/user.model.js";
import { sendSuccess } from "../utils/api-response.js";
import { escapeRegex, paginationMeta, parsePagination } from "../utils/pagination.js";

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
      User.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
      User.countDocuments(filter),
    ]);

    sendSuccess(res, {
      data: { items: items.map((u) => u.toJSON()), pagination: paginationMeta(pagination, total) },
    });
  },
);

export default router;
