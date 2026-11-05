import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { AdminRole, ROLE_META } from '../../shared/models/user.models';
import { NavItem, PanelShell } from '../panel-shell/panel-shell';

const PROFILE: NavItem[] = [{ label: 'Profile', icon: 'manage_accounts', link: '/admin/profile' }];

/** Each admin role gets its own menu; the API checks every call regardless. */
const NAV: Record<AdminRole, NavItem[]> = {
  // The super admin monitors each team's area through its own expandable tree.
  admin: [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/admin', exact: true },
    {
      label: 'Operations',
      icon: 'activity',
      children: [
        { label: 'Overview', icon: 'space_dashboard', link: '/admin/operations', exact: true },
        { label: 'Orders', icon: 'receipt_long', link: '/admin/orders' },
        { label: 'Restaurants', icon: 'storefront', link: '/admin/restaurants' },
        { label: 'Food items', icon: 'ramen_dining', link: '/admin/foods' },
        { label: 'Delivery partners', icon: 'two_wheeler', link: '/admin/delivery-partners' },
        { label: 'Order monitoring', icon: 'monitor', link: '/admin/operations/monitoring' },
        { label: 'Delivery reports', icon: 'insights', link: '/admin/operations/reports' },
      ],
    },
    {
      label: 'Finance',
      icon: 'landmark',
      children: [
        { label: 'Overview', icon: 'space_dashboard', link: '/admin/finance', exact: true },
        { label: 'Transactions', icon: 'payments', link: '/admin/payments' },
        { label: 'Restaurant payouts', icon: 'storefront', link: '/admin/finance/payouts/restaurant' },
        { label: 'Rider payments', icon: 'two_wheeler', link: '/admin/finance/payouts/rider' },
        { label: 'Refunds', icon: 'undo-2', link: '/admin/finance/refunds' },
        { label: 'Commission', icon: 'percent', link: '/admin/finance/commission' },
        { label: 'Financial reports', icon: 'chart-line', link: '/admin/reports' },
      ],
    },
    {
      label: 'Support',
      icon: 'life-buoy',
      children: [
        { label: 'Overview', icon: 'space_dashboard', link: '/admin/support', exact: true },
        { label: 'All tickets', icon: 'ticket', link: '/admin/support/queue/all' },
        { label: 'Customer complaints', icon: 'users-round', link: '/admin/support/queue/customer' },
        { label: 'Restaurant complaints', icon: 'storefront', link: '/admin/support/queue/restaurant' },
        { label: 'Rider complaints', icon: 'two_wheeler', link: '/admin/support/queue/delivery' },
        { label: 'Refund requests', icon: 'undo-2', link: '/admin/support/queue/refunds' },
        { label: 'Reviews', icon: 'star', link: '/admin/reviews' },
      ],
    },
    {
      label: 'Coins & rewards',
      icon: 'coins',
      children: [
        { label: 'Overview', icon: 'space_dashboard', link: '/admin/rewards', exact: true },
        { label: 'Settings', icon: 'settings', link: '/admin/rewards/settings' },
        { label: 'Campaigns', icon: 'party-popper', link: '/admin/rewards/campaigns' },
        { label: 'Referrals', icon: 'user-plus', link: '/admin/rewards/referrals' },
        { label: 'Coin transactions', icon: 'coins', link: '/admin/rewards/transactions' },
        { label: 'Reward history', icon: 'gift', link: '/admin/rewards/history' },
      ],
    },
    { label: 'Categories', icon: 'category', link: '/admin/categories' },
    { label: 'Coupons', icon: 'local_offer', link: '/admin/coupons' },
    { label: 'Users', icon: 'group', link: '/admin/users' },
    { label: 'Admin management', icon: 'user-cog', link: '/admin/admins' },
    { label: 'Audit log', icon: 'scroll-text', link: '/admin/audit-log' },
    { label: 'Profile', icon: 'manage_accounts', link: '/admin/profile' },
  ],
  operations_admin: [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/admin/operations', exact: true },
    { label: 'Orders management', icon: 'receipt_long', link: '/admin/orders' },
    { label: 'Restaurant management', icon: 'storefront', link: '/admin/restaurants' },
    { label: 'Delivery management', icon: 'two_wheeler', link: '/admin/delivery-partners' },
    { label: 'Order monitoring', icon: 'monitor', link: '/admin/operations/monitoring' },
    { label: 'Reports', icon: 'insights', link: '/admin/operations/reports' },
    ...PROFILE,
  ],
  finance_admin: [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/admin/finance', exact: true },
    { label: 'Transactions', icon: 'payments', link: '/admin/payments' },
    { label: 'Restaurant payouts', icon: 'storefront', link: '/admin/finance/payouts/restaurant' },
    { label: 'Delivery partner payments', icon: 'two_wheeler', link: '/admin/finance/payouts/rider' },
    { label: 'Refund management', icon: 'undo-2', link: '/admin/finance/refunds' },
    { label: 'Commission management', icon: 'percent', link: '/admin/finance/commission' },
    { label: 'Financial reports', icon: 'insights', link: '/admin/reports' },
    ...PROFILE,
  ],
  support_admin: [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/admin/support', exact: true },
    { label: 'All support tickets', icon: 'ticket', link: '/admin/support/queue/all' },
    { label: 'Customer complaints', icon: 'users-round', link: '/admin/support/queue/customer' },
    { label: 'Restaurant complaints', icon: 'storefront', link: '/admin/support/queue/restaurant' },
    {
      label: 'Delivery partner complaints',
      icon: 'two_wheeler',
      link: '/admin/support/queue/delivery',
    },
    { label: 'Refund requests', icon: 'undo-2', link: '/admin/support/queue/refunds' },
    { label: 'Reviews', icon: 'star', link: '/admin/reviews' },
    { label: 'Orders', icon: 'receipt_long', link: '/admin/orders' },
    ...PROFILE,
  ],
};

@Component({
  selector: 'bb-admin-layout',
  imports: [PanelShell],
  templateUrl: './admin-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLayout {
  private readonly auth = inject(AuthService);
  private readonly role = computed(() => (this.auth.role() ?? 'admin') as AdminRole);
  protected readonly nav = computed(() => NAV[this.role()] ?? []);
  protected readonly label = computed(() =>
    this.role() === 'admin' ? 'Admin' : ROLE_META[this.role()].label.replace(' admin', ''),
  );
}
