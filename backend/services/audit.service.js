import { logger } from "../config/logger.js";
import { AuditLog } from "../models/audit-log.model.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";

const clip = (text, max) => String(text ?? "").slice(0, max);

/** Stores one audit entry. Best-effort: a logging failure never fails the admin's action. */
export async function record(user, entry, ip) {
  try {
    await AuditLog.create({
      admin: user._id,
      adminRole: user.role,
      action: entry.action,
      description: clip(entry.description, 500),
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ? String(entry.resourceId) : undefined,
      ip: clip(ip, 64) || undefined,
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, "Could not write audit log");
  }
}

/**
 * Route middleware: once the request succeeds (status < 400), records `action` against the
 * resource in `req.params.id`. `describe(req)` builds the human-readable line.
 */
export const audited =
  (action, resourceType, describe) => (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.user) return;
      void record(
        req.user,
        {
          action,
          resourceType,
          resourceId: req.params.id ?? req.auditResourceId,
          description: describe(req),
        },
        req.ip,
      );
    });
    next();
  };

export async function list({ action, role, search, from, to }, pagination) {
  const filter = {};
  if (action) filter.action = action;
  if (role) filter.adminRole = role;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ description: pattern }, { resourceId: search }];
  }
  if (from || to)
    filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate("admin", "name email"),
    AuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map((entry) => {
      const json = entry.toJSON();
      return {
        ...json,
        admin: entry.admin
          ? { id: String(entry.admin._id), name: entry.admin.name, email: entry.admin.email }
          : null,
      };
    }),
    pagination: paginationMeta(pagination, total),
  };
}
