export type StaffAdminRole = 'operations_admin' | 'finance_admin' | 'support_admin';
/** `admin` is the super admin; the staff admin roles each get a slice of the admin panel. */
export type AdminRole = 'admin' | StaffAdminRole;
export type Role = 'customer' | 'restaurant' | 'delivery' | AdminRole;
export type SelfRegisterRole = 'customer' | 'restaurant' | 'delivery';

export const STAFF_ADMIN_ROLES: readonly StaffAdminRole[] = [
  'operations_admin',
  'finance_admin',
  'support_admin',
];
export const ADMIN_ROLES: readonly AdminRole[] = ['admin', ...STAFF_ADMIN_ROLES];
export const isAdminRole = (role: Role | null | undefined): role is AdminRole =>
  !!role && (ADMIN_ROLES as readonly Role[]).includes(role);

/** Mirrors backend config/permissions.js. The API enforces them; the app only shapes menus. */
export type Permission =
  | 'admins:manage'
  | 'users:manage'
  | 'audit:view'
  | 'catalog:manage'
  | 'operations:view'
  | 'orders:view'
  | 'orders:manage'
  | 'restaurants:manage'
  | 'riders:manage'
  | 'finance:view'
  | 'refunds:manage'
  | 'payouts:manage'
  | 'support:manage'
  | 'reviews:moderate'
  | 'rewards:manage'
  | 'rewards:view'
  | 'promotions:send';
export type UserStatus = 'active' | 'suspended';

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: Role;
  status: UserStatus;
  /** Admin roles only. */
  permissions?: Permission[];
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  user: User;
  accessToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  portal?: Role;
}

export interface RegisterRequest {
  name: string;
  email: string;
  phone?: string;
  password: string;
  role: SelfRegisterRole;
  /** A friend's referral code (customers only). */
  referralCode?: string;
}

export interface UpdateProfileRequest {
  name?: string;
  phone?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export const ROLE_META: Record<
  Role,
  { label: string; home: string; login: string; register?: string }
> = {
  customer: { label: 'Customer', home: '/', login: '/login', register: '/register' },
  admin: { label: 'Super admin', home: '/admin', login: '/login' },
  operations_admin: { label: 'Operations admin', home: '/admin/operations', login: '/login' },
  finance_admin: { label: 'Finance admin', home: '/admin/finance', login: '/login' },
  support_admin: { label: 'Support admin', home: '/admin/support', login: '/login' },
  restaurant: {
    label: 'Restaurant partner',
    home: '/restaurant',
    login: '/login',
    register: '/restaurant/register',
  },
  delivery: {
    label: 'Delivery partner',
    home: '/delivery',
    login: '/login',
    register: '/delivery/register',
  },
};

export const initialsOf = (name = ''): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
