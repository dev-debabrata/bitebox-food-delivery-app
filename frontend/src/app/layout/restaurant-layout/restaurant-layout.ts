import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RestaurantOrderBoard } from '../../core/services/restaurant-order-board';
import { NavItem, PanelShell } from '../panel-shell/panel-shell';

@Component({
  selector: 'bb-restaurant-layout',
  imports: [PanelShell],
  templateUrl: './restaurant-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantLayout {
  private readonly board = inject(RestaurantOrderBoard);

  protected readonly nav: NavItem[] = [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/restaurant', exact: true },
    {
      label: 'Orders',
      icon: 'receipt_long',
      link: '/restaurant/orders',
      badge: this.board.pendingCount,
    },
    { label: 'Restaurant details', icon: 'storefront', link: '/restaurant/details' },
    { label: 'Menu', icon: 'menu_book', link: '/restaurant/menu' },
    { label: 'Reviews', icon: 'star', link: '/restaurant/reviews' },
    { label: 'Earnings', icon: 'account_balance_wallet', link: '/restaurant/earnings' },
    { label: 'Profile', icon: 'manage_accounts', link: '/restaurant/profile' },
  ];

  constructor() {
    this.board.connect(inject(DestroyRef));
  }
}
