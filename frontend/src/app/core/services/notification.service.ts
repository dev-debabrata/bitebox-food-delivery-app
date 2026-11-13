import { BreakpointObserver } from '@angular/cdk/layout';
import { Injectable, inject } from '@angular/core';
import { MatSnackBar, MatSnackBarConfig } from '@angular/material/snack-bar';

/** Phones (the `phone-only` breakpoint, below 600px). */
const PHONE = '(max-width: 599.98px)';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly snackBar = inject(MatSnackBar);
  private readonly breakpoints = inject(BreakpointObserver);

  success(message: string): void {
    this.show(message, 'OK', { duration: 3500, panelClass: 'bb-snack-success' });
  }

  error(message: string): void {
    this.show(message, 'Dismiss', { duration: 6000, panelClass: 'bb-snack-error' });
  }

  info(message: string): void {
    this.show(message, 'OK', { duration: 3500 });
  }

  /**
   * Phones: at the top (at the bottom it would cover the cart bar, the floating buttons and the
   * tab bar). Tablets and desktops: the bottom-right corner, out of the content's way.
   */
  private show(message: string, action: string, config: MatSnackBarConfig): void {
    this.snackBar.open(message, action, {
      ...config,
      ...(this.breakpoints.isMatched(PHONE)
        ? { verticalPosition: 'top', panelClass: [config.panelClass ?? [], 'bb-snack-top'].flat() }
        : { horizontalPosition: 'end' }),
    });
  }
}
