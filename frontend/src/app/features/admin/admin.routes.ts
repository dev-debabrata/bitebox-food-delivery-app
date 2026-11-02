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
    path: 'coupons',
    title: 'Coupons | BiteBox Admin',
    loadComponent: () => import('./coupons/admin-coupons').then((m) => m.AdminCoupons),
  },
  {
    path: 'profile',
    title: 'Profile | BiteBox Admin',
    loadComponent: () => import('../profile/profile').then((m) => m.Profile),
  },
];
