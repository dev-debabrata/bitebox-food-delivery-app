import { inject } from '@angular/core';
import { RedirectFunction, Route, Router, Routes } from '@angular/router';
import { customerSiteGuard, guestGuard, roleGuard } from './core/guards/auth.guards';
import { SelfRegisterRole } from './shared/models/user.models';

/** Login/register style page: only reachable while signed out. */
const authPage = (
  path: string,
  loadComponent: Route['loadComponent'],
  title: string,
  data: Record<string, unknown> = {},
): Route => ({
  path,
  canActivate: [guestGuard],
  loadComponent,
  title: `${title} | BiteBox`,
  data: { ...data, heading: title },
});

const login = () => import('./features/auth/login/login').then((m) => m.Login);
const register = () => import('./features/auth/register/register').then((m) => m.Register);
const registerAs = (role: SelfRegisterRole) => ({ role });
/** Old per-role sign-in addresses -> /login, keeping ?returnUrl= and ?reason=. */
const toLogin: RedirectFunction = ({ queryParams }) => inject(Router).createUrlTree(['/login'], { queryParams });
const customerLayout = () =>
  import('./layout/customer-layout/customer-layout').then((m) => m.CustomerLayout);

export const routes: Routes = [
  // Home page. Must come before the empty-path auth group below, which would
  // otherwise match "/" and render an empty auth layout.
  {
    path: '',
    pathMatch: 'full',
    loadComponent: customerLayout,
    children: [
      {
        path: '',
        canActivate: [customerSiteGuard],
        title: 'BiteBox | Food delivery from local restaurants',
        loadComponent: () => import('./features/customer/home/home').then((m) => m.Home),
      },
    ],
  },

  // Authentication pages (one shared split-screen layout)
  {
    path: '',
    loadComponent: () => import('./layout/auth-layout/auth-layout').then((m) => m.AuthLayout),
    children: [
      authPage('login', login, 'Sign in'),
      authPage('register', register, 'Create your account', registerAs('customer')),
      authPage(
        'forgot-password',
        () => import('./features/auth/forgot-password/forgot-password').then((m) => m.ForgotPassword),
        'Forgot password',
      ),
      {
        path: 'reset-password',
        loadComponent: () =>
          import('./features/auth/reset-password/reset-password').then((m) => m.ResetPassword),
        title: 'Reset password | BiteBox',
        data: { heading: 'Choose a new password' },
      },
      authPage('restaurant/register', register, 'Partner your restaurant', registerAs('restaurant')),
      authPage('delivery/register', register, 'Ride with BiteBox', registerAs('delivery')),
      // One sign-in page for every role; the old per-role addresses still work.
      { path: 'admin/login', redirectTo: toLogin },
      { path: 'restaurant/login', redirectTo: toLogin },
      { path: 'delivery/login', redirectTo: toLogin },
    ],
  },

  // Admin panel
  {
    path: 'admin',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./layout/admin-layout/admin-layout').then((m) => m.AdminLayout),
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },

  // Restaurant panel
  {
    path: 'restaurant',
    canActivate: [roleGuard('restaurant')],
    loadComponent: () =>
      import('./layout/restaurant-layout/restaurant-layout').then((m) => m.RestaurantLayout),
    loadChildren: () =>
      import('./features/restaurant-panel/restaurant-panel.routes').then((m) => m.RESTAURANT_ROUTES),
  },

  // Delivery partner panel
  {
    path: 'delivery',
    canActivate: [roleGuard('delivery')],
    loadComponent: () =>
      import('./layout/delivery-layout/delivery-layout').then((m) => m.DeliveryLayout),
    loadChildren: () =>
      import('./features/delivery-panel/delivery-panel.routes').then((m) => m.DELIVERY_ROUTES),
  },

  // Customer-facing pages, plus /forbidden and the 404 fallback
  {
    path: '',
    loadComponent: customerLayout,
    canActivateChild: [customerSiteGuard],
    loadChildren: () => import('./features/customer/customer.routes').then((m) => m.CUSTOMER_ROUTES),
  },
];
