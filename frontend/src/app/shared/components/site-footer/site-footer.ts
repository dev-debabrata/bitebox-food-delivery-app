import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { IconComponent } from 'nexprime';
import { catchError, map, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { PaymentService } from '../../../core/services/payment.service';
import { BrandLogo } from '../brand-logo/brand-logo';
import {
  APP_LINKS,
  BOTTOM_LINKS,
  FOOTER_GROUPS,
  PARTNER_CARDS,
  SOCIAL_LINKS,
  available,
} from './footer-links';
import { NewsletterSignup } from './newsletter-signup/newsletter-signup';

/**
 * The customer site footer. Links come from footer-links.ts and only those leading to a real page
 * or a configured URL are shown. `compact` keeps just the bottom bar (checkout).
 */
@Component({
  selector: 'bb-site-footer',
  imports: [NgTemplateOutlet, RouterLink, IconComponent, BrandLogo, NewsletterSignup],
  templateUrl: './site-footer.html',
  styleUrl: './site-footer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SiteFooter {
  readonly compact = input(false);

  protected readonly year = new Date().getFullYear();
  protected readonly groups = computed(() =>
    FOOTER_GROUPS.map((g) => ({
      ...g,
      links: available(g.links).filter((l) => !(l.visitorsOnly && this.signedIn())),
    })).filter((g) => g.links.length),
  );
  protected readonly bottomLinks = available(BOTTOM_LINKS);
  protected readonly partners = PARTNER_CARDS;
  /** Partner sign-up is for visitors; signed-in users don't see it (display only, not access). */
  private readonly displayUser = inject(AuthService).displayUser;
  protected readonly signedIn = computed(() => this.displayUser() !== null);
  protected readonly social = available(SOCIAL_LINKS);
  protected readonly apps = available(APP_LINKS);

  /** Phones get collapsible link groups; wider screens show them all. */
  protected readonly phone = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 599.98px)')
      .pipe(map((s) => s.matches)),
    { initialValue: false },
  );
  protected readonly openGroup = signal<string | null>(null);
  protected toggle(title: string): void {
    this.openGroup.update((open) => (open === title ? null : title));
  }

  /** What checkout really accepts (cached app-wide); online methods only with a live gateway. */
  private readonly methods = toSignal(inject(PaymentService).methods$.pipe(catchError(() => of([]))), {
    initialValue: [],
  });
  protected readonly payments = computed(() => {
    const methods = this.methods();
    const online = methods.some((m) => m.method === 'online' && !m.simulated);
    return [
      ...(online
        ? [
            { label: 'UPI', icon: 'smartphone' },
            { label: 'Credit & debit cards', icon: 'credit-card' },
            { label: 'Net banking', icon: 'landmark' },
            { label: 'Wallets', icon: 'wallet' },
          ]
        : []),
      ...(methods.some((m) => m.method === 'cod') ? [{ label: 'Cash on delivery', icon: 'banknote' }] : []),
    ];
  });
}
