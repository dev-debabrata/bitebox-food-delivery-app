import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, filter, switchMap, throwError } from 'rxjs';
import { confirmed } from '../../shared/components/confirm-dialog/confirm-dialog';
import { AuthService } from '../auth/auth.service';
import { errorCode, errorMessage } from './api-error';
import { CartService } from './cart.service';
import { NotificationService } from './notification.service';
import { BbDialog } from '../../shared/dialog/bb-dialog';

@Injectable({ providedIn: 'root' })
export class CartActions {
  private readonly cart = inject(CartService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly bbDialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  canOrder(): boolean {
    const role = this.auth.role();
    return role === null || role === 'customer';
  }

  add(foodItemId: string, dishName: string): void {
    if (!this.auth.isAuthenticated()) {
      void this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this.cart
      .add(foodItemId)
      .pipe(
        catchError((err: unknown) => {
          if (errorCode(err) !== 'CART_RESTAURANT_CONFLICT') return throwError(() => err);
          return this.confirmReplace(errorMessage(err)).pipe(
            switchMap(() => this.cart.add(foodItemId, 1, true)),
          );
        }),
      )
      .subscribe({
        next: () => this.notify.success(`${dishName} added to cart`),
        error: (err: unknown) => this.notify.error(errorMessage(err)),
      });
  }

  setQuantity(foodItemId: string, quantity: number): void {
    this.cart
      .setQuantity(foodItemId, quantity)
      .subscribe({ error: (err: unknown) => this.notify.error(errorMessage(err)) });
  }

  private confirmReplace(message: string): Observable<true> {
    return confirmed(
      this.bbDialog,
      { title: 'Start a new cart?', message, confirmLabel: 'Start new cart' },
      '420px',
    ).pipe(filter((ok): ok is true => ok === true));
  }
}
