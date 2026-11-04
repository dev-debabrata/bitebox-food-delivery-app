import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NavItem, PanelShell } from '../panel-shell/panel-shell';

@Component({
  selector: 'bb-admin-layout',
  imports: [PanelShell],
  templateUrl: './admin-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLayout {
  protected readonly nav: NavItem[] = [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/admin', exact: true },
    { label: 'Orders', icon: 'receipt_long', link: '/admin/orders' },
    { label: 'Reports', icon: 'insights', link: '/admin/reports' },
    { label: 'Payments', icon: 'payments', link: '/admin/payments' },
    { label: 'Restaurants', icon: 'storefront', link: '/admin/restaurants' },
    { label: 'Categories', icon: 'category', link: '/admin/categories' },
    { label: 'Food items', icon: 'ramen_dining', link: '/admin/foods' },
    { label: 'Reviews', icon: 'star', link: '/admin/reviews' },
    { label: 'Coupons', icon: 'local_offer', link: '/admin/coupons' },
    { label: 'Delivery partners', icon: 'two_wheeler', link: '/admin/delivery-partners' },
    { label: 'Users', icon: 'group', link: '/admin/users' },
    { label: 'Profile', icon: 'manage_accounts', link: '/admin/profile' },
  ];
}
