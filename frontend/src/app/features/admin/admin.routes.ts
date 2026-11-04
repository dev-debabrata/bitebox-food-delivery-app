import { Routes } from '@angular/router';

export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Admin dashboard | BiteBox',
    loadComponent: () => import('./dashboard/admin-dashboard').then((m) => m.AdminDashboard),
  },
  {
    path: 'orders',
    title: 'Orders | BiteBox Admin',
    loadComponent: () => import('./orders/admin-orders').then((m) => m.AdminOrders),
  },
  {
    path: 'reports',
    title: 'Reports | BiteBox Admin',
    loadComponent: () => import('./reports/admin-reports').then((m) => m.AdminReports),
  },
  {
    path: 'payments',
    title: 'Payments | BiteBox Admin',
    loadComponent: () => import('./payments/admin-payments').then((m) => m.AdminPayments),
  },
  {
    path: 'delivery-partners',
    title: 'Delivery partners | BiteBox Admin',
    loadComponent: () => import('./delivery-partners/admin-delivery-partners').then((m) => m.AdminDeliveryPartners),
  },
  {
    path: 'users',
    title: 'Users | BiteBox Admin',
    loadComponent: () => import('./users/admin-users').then((m) => m.AdminUsers),
  },
  {
    path: 'restaurants',
    title: 'Restaurants | BiteBox Admin',
    loadComponent: () => import('./restaurants/admin-restaurants').then((m) => m.AdminRestaurants),
  },
  {
    path: 'restaurants/:id',
    title: 'Review restaurant | BiteBox Admin',
    loadComponent: () =>
      import('./restaurant-review/admin-restaurant-review').then((m) => m.AdminRestaurantReview),
  },
  {
    path: 'categories',
    title: 'Food categories | BiteBox Admin',
    loadComponent: () => import('./categories/admin-categories').then((m) => m.AdminCategories),
  },
  {
    path: 'foods',
    title: 'Food items | BiteBox Admin',
    loadComponent: () => import('./foods/admin-foods').then((m) => m.AdminFoods),
  },
  {
    path: 'reviews',
    title: 'Reviews | BiteBox Admin',
    loadComponent: () => import('./reviews/admin-reviews').then((m) => m.AdminReviews),
  },
  {
    path: 'coupons',
    title: 'Coupons | BiteBox Admin',
    loadComponent: () => import('./coupons/admin-coupons').then((m) => m.AdminCoupons),
  },
  {
    path: 'notifications',
    title: 'Notifications | BiteBox Admin',
    loadComponent: () => import('../notifications/notifications-page').then((m) => m.NotificationsPage),
  },
  {
    path: 'profile',
    title: 'Profile | BiteBox Admin',
    loadComponent: () => import('../profile/profile').then((m) => m.Profile),
  },
];
