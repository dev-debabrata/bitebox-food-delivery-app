import { Routes } from '@angular/router';

export const DELIVERY_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Delivery dashboard | BiteBox',
    loadComponent: () => import('./dashboard/delivery-dashboard').then((m) => m.DeliveryDashboard),
  },
  {
    path: 'history',
    title: 'Delivery history | BiteBox Delivery',
    loadComponent: () => import('./history/delivery-history').then((m) => m.DeliveryHistory),
  },
  {
    path: 'reviews',
    title: 'Ratings | BiteBox Delivery',
    loadComponent: () => import('./reviews/delivery-reviews').then((m) => m.DeliveryReviews),
  },
  {
    path: 'earnings',
    title: 'Earnings | BiteBox Delivery',
    data: { scope: 'rider' },
    loadComponent: () => import('../earnings/earnings-page').then((m) => m.EarningsPage),
  },
  {
    path: 'notifications',
    title: 'Notifications | BiteBox Delivery',
    loadComponent: () => import('../notifications/notifications-page').then((m) => m.NotificationsPage),
  },
  {
    path: 'profile',
    title: 'Profile | BiteBox Delivery',
    loadComponent: () => import('../profile/profile').then((m) => m.Profile),
  },
  {
    path: 'support',
    title: 'Help & support | BiteBox Delivery',
    loadComponent: () => import('../support/my-tickets/my-tickets').then((m) => m.MyTickets),
  },
  {
    path: 'support/:id',
    title: 'Support ticket | BiteBox Delivery',
    loadComponent: () => import('../support/my-ticket/my-ticket').then((m) => m.MyTicket),
  },
];
