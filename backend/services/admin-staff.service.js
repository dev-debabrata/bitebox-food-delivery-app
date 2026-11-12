import { Session } from "../models/session.model.js";
import {
  ADMIN_ROLES,
  MEMBER_ROLES,
  ROLES,
  STAFF_ADMIN_ROLES,
  USER_STATUS,
  User,
} from "../models/user.model.js";
import { Session } from "../models/session.model.js";
import { ApiError } from "../utils/api-error.js";
import { escapeRegex, paginationMeta } from "../utils/pagination.js";
import { endSessions, hashPassword } from "./auth.service.js";
import { adminSetStatus as setRiderStatus } from "./delivery-partner.service.js";

/**
 * Suspends or reactivates an account whose role is in `roles` (the Users page passes member roles,
 * Admin management admin roles). Riders go through their own flow (they may be carrying an order).
 */
export async function setAccountStatus(actorId, userId, status, roles) {
  if (String(actorId) === String(userId))
    throw ApiError.badRequest("You cannot suspend your own account");
  const user = await User.findById(userId).select("+tokenVersion");
  if (!user) throw ApiError.notFound("User not found");
  if (!roles.includes(user.role))
    throw ApiError.badRequest(
      ADMIN_ROLES.includes(user.role)
        ? "Manage admin accounts from Admin management"
        : "This is not an admin account",
    );
  if (user.role === ROLES.DELIVERY) return setRiderStatus(user._id, status);

  user.status = status;
  await endSessions(
    user,
    status === USER_STATUS.SUSPENDED ? "suspended" : "logout",
  );
  return user.toJSON();
}

/** A page of accounts with one of `roles` (or just `role`), newest first. */
export async function listUsers(roles, { role, status, search }, pagination) {
  const filter = { role: role ?? { $in: roles } };
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
  return {
    items: items.map((u) => u.toJSON()),
    pagination: paginationMeta(pagination, total),
  };
}

export const listMembers = (query, pagination) =>
  listUsers(MEMBER_ROLES, query, pagination);
export const listStaff = (query, pagination) =>
  listUsers(ADMIN_ROLES, query, pagination);

export async function getStaff(id) {
  const user = await User.findOne({ _id: id, role: { $in: ADMIN_ROLES } });
  if (!user) throw ApiError.notFound("Admin not found");
  return user.toJSON();
}

export async function createStaff({ name, email, phone, password, role }) {
  if (!STAFF_ADMIN_ROLES.includes(role))
    throw ApiError.badRequest("Choose an operations, finance or support role");
  if (await User.exists({ email }))
    throw ApiError.conflict("An account with this email already exists");
  if (phone && (await User.exists({ phone })))
    throw ApiError.conflict("An account with this phone number already exists");
  const user = await User.create({
    name,
    email,
    phone,
    role,
    passwordHash: await hashPassword(password),
  });
  return user.toJSON();
}

/**
 * Edits a staff admin. Super admins are not editable here, and nobody edits their own role.
 * A role change signs the admin out so their next session gets the new permissions.
 */
export async function updateStaff(actorId, id, { name, phone, role }) {
  if (String(actorId) === String(id))
    throw ApiError.badRequest("Use your profile page to edit your own account");
  const user = await User.findOne({
    _id: id,
    role: { $in: STAFF_ADMIN_ROLES },
  }).select("+tokenVersion");
  if (!user) throw ApiError.notFound("Admin not found");
  if (phone && phone !== user.phone && (await User.exists({ phone })))
    throw ApiError.conflict("An account with this phone number already exists");

  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone || undefined;
  const roleChanged = role !== undefined && role !== user.role;
  if (roleChanged) {
    user.role = role;
    await endSessions(user, "role-change");
  } else {
    await user.save();
  }
  return user.toJSON();
}

/**
 * Sign-ins of one account, newest first. A sign-in is a session family: refreshes rotate the
 * token inside it, so its first row is the sign-in and its newest row says whether it is still
 * active. (Expired sessions are purged by a TTL index, so history covers the refresh lifetime.)
 */
export async function loginHistory(userId, roles, pagination) {
  if (!(await User.exists({ _id: userId, role: { $in: roles } })))
    throw ApiError.notFound("User not found");
  const [{ families, total }] = await Session.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: "$family",
        signedInAt: { $first: "$createdAt" },
        lastActiveAt: { $last: "$createdAt" },
        ip: { $first: "$ip" },
        userAgent: { $first: "$userAgent" },
        last: { $last: { revokedAt: "$revokedAt", reason: "$revokedReason", expiresAt: "$expiresAt" } },
      },
    },
    {
      $facet: {
        families: [
          { $sort: { signedInAt: -1 } },
          { $skip: pagination.skip },
          { $limit: pagination.limit },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);
  const now = new Date();
  return {
    items: families.map((f) => {
      const active = !f.last.revokedAt && f.last.expiresAt > now;
      return {
        signedInAt: f.signedInAt,
        lastActiveAt: f.lastActiveAt,
        ip: f.ip ?? null,
        userAgent: f.userAgent ?? null,
        active,
        endedReason: active ? null : (f.last.reason ?? "expired"),
      };
    }),
    pagination: paginationMeta(pagination, total[0]?.n ?? 0),
  };
}
