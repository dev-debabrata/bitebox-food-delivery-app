export const ROLES = Object.freeze({
  CUSTOMER: "customer",
  /** The super admin: every permission, and the only role that manages other admins. */
  ADMIN: "admin",
  RESTAURANT: "restaurant",
  DELIVERY: "delivery",
  OPERATIONS_ADMIN: "operations_admin",
  FINANCE_ADMIN: "finance_admin",
  SUPPORT_ADMIN: "support_admin",
});

export const ALL_ROLES = Object.values(ROLES);

/** Staff roles a super admin can create and assign (see config/permissions.js). */
export const STAFF_ADMIN_ROLES = Object.freeze([
  ROLES.OPERATIONS_ADMIN,
  ROLES.FINANCE_ADMIN,
  ROLES.SUPPORT_ADMIN,
]);
/** Every role that signs in to the /admin panel. */
export const ADMIN_ROLES = Object.freeze([ROLES.ADMIN, ...STAFF_ADMIN_ROLES]);
/** Customers, restaurant partners and riders: the accounts on the Users page. */
export const MEMBER_ROLES = Object.freeze(
  ALL_ROLES.filter((r) => !ADMIN_ROLES.includes(r)),
);

export const ROLE_LABEL = Object.freeze({
  [ROLES.CUSTOMER]: "Customer",
  [ROLES.ADMIN]: "Super admin",
  [ROLES.RESTAURANT]: "Restaurant partner",
  [ROLES.DELIVERY]: "Delivery partner",
  [ROLES.OPERATIONS_ADMIN]: "Operations admin",
  [ROLES.FINANCE_ADMIN]: "Finance admin",
  [ROLES.SUPPORT_ADMIN]: "Support admin",
});
