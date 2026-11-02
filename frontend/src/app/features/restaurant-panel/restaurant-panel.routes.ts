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
    path: 'profile',
    title: 'Profile | BiteBox Restaurant',
    loadComponent: () => import('../profile/profile').then((m) => m.Profile),
  },
];
