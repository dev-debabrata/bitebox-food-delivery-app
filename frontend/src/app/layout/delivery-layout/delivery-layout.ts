import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NavItem, PanelShell } from '../panel-shell/panel-shell';

@Component({
  selector: 'bb-delivery-layout',
  imports: [PanelShell],
  templateUrl: './delivery-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryLayout {
  protected readonly nav: NavItem[] = [
    { label: 'Dashboard', icon: 'space_dashboard', link: '/delivery', exact: true },
    { label: 'History', icon: 'history', link: '/delivery/history' },
    { label: 'Ratings', icon: 'star', link: '/delivery/reviews' },
    { label: 'Earnings', icon: 'account_balance_wallet', link: '/delivery/earnings' },
    { label: 'Help & support', icon: 'life-buoy', link: '/delivery/support' },
    { label: 'Profile', icon: 'manage_accounts', link: '/delivery/profile' },
  ];
}
