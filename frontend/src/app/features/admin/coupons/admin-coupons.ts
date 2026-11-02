import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ToggleComponent } from 'nexprime';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { filter } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { AdminCouponService } from '../../../core/services/checkout-api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { AdminCoupon } from '../../../shared/models/checkout.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { CouponFormDialog } from './coupon-form-dialog';

@Component({
  selector: 'bb-admin-coupons',
  imports: [ToggleComponent, DatePipe, MatButtonModule, MatIconModule, MatDialogModule, EmptyState, PageHeader, InrPipe],
  templateUrl: './admin-coupons.html',
  styleUrl: './admin-coupons.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCoupons {
  private readonly service = inject(AdminCouponService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly coupons = signal<AdminCoupon[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.service.list({ limit: 100 }).subscribe({
      next: (res) => {
        this.coupons.set(res.items);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load coupons.'));
        this.loading.set(false);
      },
    });
  }

  protected expired(c: AdminCoupon): boolean {
    return new Date(c.validUntil).getTime() < Date.now();
  }

  protected open(coupon?: AdminCoupon): void {
    this.dialog
      .open<CouponFormDialog, AdminCoupon | null, AdminCoupon>(CouponFormDialog, { data: coupon ?? null, width: '560px', maxWidth: '95vw' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
        this.notify.success(coupon ? 'Coupon saved' : 'Coupon created');
        this.load();
      });
  }

  protected toggle(coupon: AdminCoupon, checked: boolean, toggle: ToggleComponent): void {
    this.service.update(coupon.id, { isActive: checked }).subscribe({
      next: () => this.coupons.update((list) => list.map((c) => (c.id === coupon.id ? { ...c, isActive: checked } : c))),
      error: (err: unknown) => {
        toggle.checked.set(!checked); // back to what the server has
        this.notify.error(errorMessage(err));
      },
    });
  }

  protected remove(coupon: AdminCoupon): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: { title: `Delete ${coupon.code}?`, message: 'Customers will no longer be able to use it.', confirmLabel: 'Delete', danger: true },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.service.remove(coupon.id).subscribe({
          next: () => {
            this.coupons.update((list) => list.filter((c) => c.id !== coupon.id));
            this.notify.success('Coupon deleted');
          },
          error: (err: unknown) => this.notify.error(errorMessage(err)),
        }),
      );
  }
}
