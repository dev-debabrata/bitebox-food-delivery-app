import { NpIconPipe } from '../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, Signal, computed, inject, input, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { NotificationBell } from '../../shared/components/notification-bell/notification-bell';
import { BrandLogo } from '../../shared/components/brand-logo/brand-logo';

export interface NavItem {
  label: string;
  icon: string;
  link: string;
  /** Match the link exactly (use for index routes such as the dashboard). */
  exact?: boolean;
  /** Count shown next to the label (e.g. new orders); hidden when 0. */
  badge?: Signal<number>;
}

/**
 * Shared chrome for the Admin, Restaurant and Delivery panels.
 * Desktop (>= 1024px): persistent sidebar. Tablet/phone: overlay drawer
 * opened from the toolbar and closed automatically after navigation.
 */
import { initialsOf } from '../../shared/models/user.models';

@Component({
  selector: 'bb-panel-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatDividerModule,
    IconComponent, NpIconPipe,
    MatListModule,
    MatMenuModule,
    MatSidenavModule,
    MatToolbarModule,
    BrandLogo,
    NotificationBell,
  ],
  templateUrl: './panel-shell.html',
  styleUrl: './panel-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanelShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly panelLabel = input.required<string>();
  readonly navItems = input.required<NavItem[]>();
  readonly profileLink = input.required<string>();

  private readonly sidenav = viewChild.required(MatSidenav);

  protected readonly user = this.auth.user;
  protected readonly initials = computed(() => initialsOf(this.user()?.name) || '?');

  protected readonly isDesktop = toSignal(
    inject(BreakpointObserver)
      .observe('(min-width: 1024px)')
      .pipe(map((state) => state.matches)),
    { initialValue: true },
  );

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (!this.isDesktop()) void this.sidenav().close();
      });
  }

  protected logout(): void {
    this.auth.logout().subscribe();
  }
}
