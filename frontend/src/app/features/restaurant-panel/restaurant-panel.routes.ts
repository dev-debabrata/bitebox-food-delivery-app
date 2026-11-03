import { Routes } from '@angular/router';

export const RESTAURANT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Restaurant dashboard | BiteBox',
    loadComponent: () =>
      import('./dashboard/restaurant-dashboard').then((m) => m.RestaurantDashboard),
  },
  {
    path: 'orders',
    title: 'Orders | BiteBox Restaurant',
    loadComponent: () => import('./orders/restaurant-orders').then((m) => m.RestaurantOrders),
  },
  {
    path: 'details',
    title: 'Restaurant details | BiteBox Restaurant',
    loadComponent: () => import('./details/restaurant-details').then((m) => m.RestaurantDetails),
  },
  {
    path: 'menu',
    title: 'Menu | BiteBox Restaurant',
    loadComponent: () => import('./menu/restaurant-menu').then((m) => m.RestaurantMenu),
  },
  {
    path: 'earnings',
    title: 'Earnings | BiteBox Restaurant',
    data: { scope: 'restaurant' },
    loadComponent: () => import('../earnings/earnings-page').then((m) => m.EarningsPage),
  },
  {
    path: 'notifications',
    title: 'Notifications | BiteBox Restaurant',
    loadComponent: () => import('../notifications/notifications-page').then((m) => m.NotificationsPage),
  },
  {
    path: 'profile',
    title: 'Profile | BiteBox Restaurant',
    loadComponent: () => import('../profile/profile').then((m) => m.Profile),
  },
];
