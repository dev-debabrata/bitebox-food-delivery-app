import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConnectionStatus } from '../../../core/services/connection-status.service';
import { safeReturnUrl } from '../../../core/services/safe-url';

/**
 * Shown when a page could not be opened because the device is offline and that page's code
 * has not been saved on this device yet. It is part of the main bundle so it always loads,
 * which is why it uses plain buttons and a precached icon instead of Material and NexPrime.
 */
@Component({
  selector: 'bb-offline-page',
  imports: [RouterLink],
  templateUrl: './offline-page.html',
  styleUrl: './offline-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OfflinePage {
  private readonly router = inject(Router);
  protected readonly connection = inject(ConnectionStatus);
  /** The page the person was trying to open (?from=). */
  readonly from = input<string>();

  constructor() {
    // Back online: carry on to the page they wanted.
    effect(() => {
      if (this.connection.restored()) this.retry();
    });
  }

  protected retry(): void {
    // `from` is user-controllable: same-site paths only, never back to this page.
    const to = safeReturnUrl(this.from());
    void this.router.navigateByUrl(to && !to.startsWith('/offline') ? to : '/', { replaceUrl: true });
  }
}
