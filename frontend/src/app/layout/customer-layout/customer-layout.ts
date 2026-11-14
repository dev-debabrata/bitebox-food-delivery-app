import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
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
import { InstallBanner } from '../../shared/components/install-banner/install-banner';
import { InstallPromptService } from '../../core/services/install-prompt.service';
import { ThemeService } from '../../core/services/theme.service';
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
    InstallBanner,
  ],
  templateUrl: './customer-layout.html',
  styleUrl: './customer-layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerLayout {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly cart = inject(CartService);
  protected readonly installer = inject(InstallPromptService);
  protected readonly themes = inject(ThemeService);
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
  protected readonly photo = computed(() => this.auth.user()?.avatarUrl || null);
  private readonly url = currentUrl();
  /** Checkout gets the compact footer (no links pulling the customer away from paying). */
  protected readonly onCheckout = computed(() => this.url().startsWith('/checkout'));
  /** The install promo floats over the page, so only where nothing else sits at the bottom. */
  protected readonly installPromo = computed(() =>
    ['/', '/restaurants'].includes(this.url().split(/[?#]/)[0]),
  );

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

  protected scrollToAppDownload(event?: Event): void {
    if (!isPlatformBrowser(this.platformId)) return;
    event?.preventDefault();

    const go = () => {
      const banner = document.querySelector<HTMLElement>('#app-download .app-download-banner');
      if (!banner) return;

      const header = document.querySelector('.site-header')?.getBoundingClientRect().height ?? 0;
      const target = () => banner.getBoundingClientRect().top + window.scrollY - header - 16;

      const from = window.scrollY;
      const start = performance.now();
      const DURATION = 600;

      const step = (now: number) => {
        const p = Math.min((now - start) / DURATION, 1);
        const ease = 1 - (1 - p) ** 3;
        window.scrollTo({
          top: from + (target() - from) * ease,
          behavior: 'instant' as ScrollBehavior,
        });
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const onHome = ['', '/'].includes(this.url().split(/[?#]/)[0]);
    if (onHome) go();
    else void this.router.navigateByUrl('/').then(() => setTimeout(go, 200));
  }

  // protected scrollToAppDownload(event?: Event): void {
  //   if (!isPlatformBrowser(this.platformId)) return;
  //   event?.preventDefault();

  //   const go = () => {
  //     const banner = document.querySelector<HTMLElement>('#app-download .app-download-banner');
  //     if (!banner) return;

  //     const header = document.querySelector('.site-header')?.getBoundingClientRect().height ?? 0;
  //     const target = () => banner.getBoundingClientRect().top + window.scrollY - header - 16;

  //     const from = window.scrollY;
  //     const start = performance.now();
  //     const DURATION = 600;

  //     const step = (now: number) => {
  //       const p = Math.min((now - start) / DURATION, 1);
  //       const ease = 1 - (1 - p) ** 3; // ease-out
  //       window.scrollTo({
  //         top: from + (target() - from) * ease,
  //         behavior: 'instant' as ScrollBehavior,
  //       });
  //       if (p < 1) requestAnimationFrame(step);
  //     };
  //     requestAnimationFrame(step);

  //     history.pushState(null, '', '/#app-download');
  //   };

  //   ['', '/'].includes(this.url().split(/[?#]/)[0]) ? go() : setTimeout(go, 200);
  // }

  // protected scrollToAppDownload(event?: Event): void {
  //   if (!isPlatformBrowser(this.platformId)) return;

  //   event?.preventDefault();

  //   const scrollToSection = () => {
  //     const el = document.getElementById('app-download');

  //     if (!el) return;

  //     el.scrollIntoView({
  //       behavior: 'smooth',
  //       block: 'start',
  //     });

  //     window.history.pushState(null, '', '/#app-download');
  //   };

  //   const current = this.url().split(/[?#]/)[0];

  //   if (current === '' || current === '/') {
  //     scrollToSection();
  //   } else {
  //     setTimeout(scrollToSection, 200);
  //   }
  // }

  // protected scrollToAppDownload(event?: Event): void {
  //   if (!isPlatformBrowser(this.platformId)) return;
  //   const current = this.url().split(/[?#]/)[0];
  //   if (current === '' || current === '/') {
  //     if (event) event.preventDefault();
  //     const el = document.getElementById('app-download');
  //     if (el) {
  //       el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  //       try {
  //         window.history.pushState(null, '', '/#app-download');
  //       } catch {
  //         // ignore
  //       }
  //       return;
  //     }
  //   }
  //   setTimeout(() => {
  //     document
  //       .getElementById('app-download')
  //       ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  //   }, 200);
  // }
}
