import { Routes } from '@angular/router';
import { roleGuard } from '../../core/guards/auth.guards';

export const CUSTOMER_ROUTES: Routes = [
  {
    path: 'restaurants',
    title: 'Restaurants | BiteBox',
    loadComponent: () =>
      import('../restaurants/restaurant-list/restaurant-list').then((m) => m.RestaurantList),
  },
  {
    path: 'restaurants/:slug',
    title: 'Restaurant | BiteBox',
    loadComponent: () =>
      import('../restaurants/restaurant-detail/restaurant-detail').then((m) => m.RestaurantDetail),
  },
  {
    path: 'dishes',
    title: 'Dishes | BiteBox',
    loadComponent: () => import('../food/food-search/food-search').then((m) => m.FoodSearch),
  },
  {
    path: 'account',
    title: 'My account | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('./account/account').then((m) => m.Account),
  },
  {
    path: 'notifications',
    title: 'Notifications | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../notifications/notifications-page').then((m) => m.NotificationsPage),
  },
  {
    path: 'checkout',
    title: 'Checkout | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../checkout/checkout').then((m) => m.Checkout),
  },
  { path: 'cart', redirectTo: 'checkout' },
  {
    path: 'orders',
    title: 'My orders | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../orders/order-list/order-list').then((m) => m.OrderList),
  },
  {
    path: 'orders/:id',
    title: 'Order | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../orders/order-detail/order-detail').then((m) => m.OrderDetail),
  },
  {
    path: 'account/addresses',
    title: 'Saved addresses | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('./addresses/addresses').then((m) => m.Addresses),
  },
  {
    path: 'account/coins',
    title: 'My coins | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../rewards/coins-wallet/coins-wallet').then((m) => m.CoinsWallet),
  },
  {
    path: 'account/refer',
    title: 'Refer & earn | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../rewards/refer-earn/refer-earn').then((m) => m.ReferEarn),
  },
  {
    path: 'account/rewards',
    title: 'Rewards | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () =>
      import('../rewards/special-rewards/special-rewards').then((m) => m.SpecialRewards),
  },
  {
    path: 'support',
    title: 'Help & support | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../support/my-tickets/my-tickets').then((m) => m.MyTickets),
  },
  {
    path: 'support/:id',
    title: 'Support ticket | BiteBox',
    canActivate: [roleGuard('customer')],
    loadComponent: () => import('../support/my-ticket/my-ticket').then((m) => m.MyTicket),
  },
  {
    path: 'forbidden',
    title: 'Access denied | BiteBox',
    loadComponent: () => import('../errors/forbidden/forbidden').then((m) => m.Forbidden),
  },
  {
    path: '**',
    title: 'Page not found | BiteBox',
    loadComponent: () => import('../errors/not-found/not-found').then((m) => m.NotFound),
  },
];
