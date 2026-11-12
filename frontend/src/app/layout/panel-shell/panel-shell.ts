import { NgTemplateOutlet } from '@angular/common';
import { NpIconPipe } from '../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  Signal,
  computed,
  inject,
  input,
  linkedSignal,
  viewChild,
} from '@angular/core';
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
import { currentUrl } from '../../core/services/current-url';
import { NotificationBell } from '../../shared/components/notification-bell/notification-bell';
import { BrandLogo } from '../../shared/components/brand-logo/brand-logo';
import { InstallPromptService } from '../../core/services/install-prompt.service';
import { ThemeService } from '../../core/services/theme.service';

export interface NavItem {
  label: string;
  icon: string;
  /** Page link; a group (with `children`) has none of its own. */
  link?: string;
  exact?: boolean;
  badge?: Signal<number>;
  /** Makes the item an expandable group of sub-links. */
  children?: NavItem[];
}

import { initialsOf } from '../../shared/models/user.models';

@Component({
  selector: 'bb-panel-shell',
  imports: [
    NgTemplateOutlet,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatDividerModule,
    IconComponent,
    NpIconPipe,
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
  protected readonly installer = inject(InstallPromptService);
  protected readonly themes = inject(ThemeService);
  protected readonly initials = computed(() => initialsOf(this.user()?.name) || '?');

  private readonly url = currentUrl();

  /** Groups whose page is open; they start expanded (a manual toggle wins until the next navigation). */
  protected readonly openGroups = linkedSignal(() => {
    const path = this.url().split(/[?#]/)[0];
    return new Set(
      this.navItems()
        .filter((g) => g.children?.some((c) => c.link && path.startsWith(c.link)))
        .map((g) => g.label),
    );
  });

  protected toggleGroup(label: string): void {
    this.openGroups.update((open) => {
      const next = new Set(open);
      if (!next.delete(label)) next.add(label);
      return next;
    });
  }

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
