export type Role = 'customer' | 'admin' | 'restaurant' | 'delivery';
export type SelfRegisterRole = Exclude<Role, 'admin'>;
export type UserStatus = 'active' | 'suspended';

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: Role;
  status: UserStatus;
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
}

export interface UpdateProfileRequest {
  name?: string;
  phone?: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** Per-role metadata used by routing, layouts and auth pages. */
/** Every role signs in on the same page (/login); sign-up stays separate per role. */
export const ROLE_META: Record<Role, { label: string; home: string; login: string; register?: string }> = {
  customer: { label: 'Customer', home: '/', login: '/login', register: '/register' },
  admin: { label: 'Admin', home: '/admin', login: '/login' },
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

/** "Asha Customer" -> "AC" (first two words), for round avatars. */
export const initialsOf = (name = ''): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
