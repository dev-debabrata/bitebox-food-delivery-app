import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { IconComponent, ScrollTopComponent } from 'nexprime';
import { AuthService } from '../../core/auth/auth.service';
import { CartService } from '../../core/services/cart.service';
import { currentUrl } from '../../core/services/current-url';
import { DeliveryLocationService } from '../../core/services/delivery-location.service';
import { LocationPickerDialog } from '../../shared/components/location-picker/location-picker-dialog';
import { NotificationBell } from '../../shared/components/notification-bell/notification-bell';
import { BrandLogo } from '../../shared/components/brand-logo/brand-logo';
import { SiteFooter } from '../../shared/components/site-footer/site-footer';
import { ROLE_META } from '../../shared/models/user.models';

import { initialsOf } from '../../shared/models/user.models';

@Component({
  selector: 'bb-customer-layout',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatDividerModule,
    IconComponent,
    MatMenuModule,
    BrandLogo,
    ScrollTopComponent,
    NotificationBell,
    SiteFooter,
  ],
  templateUrl: './customer-layout.html',
  styleUrl: './customer-layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerLayout {
  private readonly auth = inject(AuthService);

  protected readonly cart = inject(CartService);
  protected readonly deliveryLocation = inject(DeliveryLocationService).location;
  private readonly dialog = inject(MatDialog);
  protected readonly shown = this.auth.displayUser;
  protected readonly ready = computed(() => this.auth.initialised() || this.shown() !== null);
  protected readonly panelLink = computed(() => {
    const role = this.shown()?.role;
    return role && role !== 'customer' ? ROLE_META[role].home : null;
  });
  protected readonly showCart = computed(
    () => this.cart.enabled() || this.shown()?.role === 'customer',
  );
  protected readonly firstName = computed(() => this.shown()?.name.split(' ')[0] ?? '');
  protected readonly initials = computed(() => initialsOf(this.shown()?.name));
  private readonly url = currentUrl();
  /** Checkout gets the compact footer (no links pulling the customer away from paying). */
  protected readonly onCheckout = computed(() => this.url().startsWith('/checkout'));

  protected chooseLocation(): void {
    this.dialog.open(LocationPickerDialog, {
      width: '520px',
      maxWidth: '95vw',
      autoFocus: 'first-tabbable',
    });
  }

  protected logout(): void {
    this.auth.logout().subscribe();
  }
}
