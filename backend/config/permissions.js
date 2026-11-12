import { ROLES } from "./roles.js";

/**
 * What each admin role may do. The API enforces these with `can(...)` (middleware/auth.middleware.js);
 * the web app only uses them to hide menu items. The super admin (ROLES.ADMIN) has every permission.
 */
export const PERMISSIONS = Object.freeze({
  ADMINS_MANAGE: "admins:manage", // create, edit, (de)activate staff admins
  USERS_MANAGE: "users:manage", // every account: list, suspend, reactivate
  AUDIT_VIEW: "audit:view",
  CATALOG_MANAGE: "catalog:manage", // categories and coupons
  OPERATIONS_VIEW: "operations:view", // operations dashboard, monitoring, delivery performance
  ORDERS_VIEW: "orders:view",
  ORDERS_MANAGE: "orders:manage", // cancel, unassign
  RESTAURANTS_MANAGE: "restaurants:manage", // onboarding, approval, menu items
  RIDERS_MANAGE: "riders:manage",
  FINANCE_VIEW: "finance:view", // finance dashboard, transactions, reports, commission
  REFUNDS_MANAGE: "refunds:manage",
  PAYOUTS_MANAGE: "payouts:manage",
  SUPPORT_MANAGE: "support:manage", // tickets
  REVIEWS_MODERATE: "reviews:moderate",
  // Coins, referral and campaign settings (super admin only), and read-only rewards reports.
  REWARDS_MANAGE: "rewards:manage",
  REWARDS_VIEW: "rewards:view",
  // Push special offers to customers who opted in (super admin only).
  PROMOTIONS_SEND: "promotions:send",
});

const P = PERMISSIONS;

export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: Object.freeze(Object.values(P)),
  [ROLES.OPERATIONS_ADMIN]: Object.freeze([
    P.OPERATIONS_VIEW,
    P.ORDERS_VIEW,
    P.ORDERS_MANAGE,
    P.RESTAURANTS_MANAGE,
    P.RIDERS_MANAGE,
  ]),
  [ROLES.FINANCE_ADMIN]: Object.freeze([
    P.FINANCE_VIEW,
    P.REFUNDS_MANAGE,
    P.PAYOUTS_MANAGE,
  ]),
  // Support reads orders to investigate complaints, but cannot change them or see finance.
  [ROLES.SUPPORT_ADMIN]: Object.freeze([
    P.SUPPORT_MANAGE,
    P.ORDERS_VIEW,
    P.REVIEWS_MODERATE,
  ]),
});

export const permissionsFor = (role) => ROLE_PERMISSIONS[role] ?? [];

export const hasPermission = (role, permission) =>
  permissionsFor(role).includes(permission);
