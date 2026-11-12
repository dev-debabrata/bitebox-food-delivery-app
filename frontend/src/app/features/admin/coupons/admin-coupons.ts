import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ButtonComponent, IconComponent, ToggleComponent } from 'nexprime';
import { filter } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { AdminCouponService } from '../../../core/services/checkout-api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { AdminCoupon } from '../../../shared/models/checkout.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { CouponFormDialog } from './coupon-form-dialog/coupon-form-dialog';
import { BbDialog } from '../../../shared/dialog/bb-dialog';

@Component({
  selector: 'bb-admin-coupons',
  imports: [
    ToggleComponent,
    DatePipe,
    IconComponent,
    EmptyState,
    PageHeader,
    InrPipe,
    ButtonComponent,
  ],
  templateUrl: './admin-coupons.html',
  styleUrl: './admin-coupons.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCoupons {
  private readonly service = inject(AdminCouponService);
  private readonly bbDialog = inject(BbDialog);
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
    this.bbDialog
      .open<CouponFormDialog, AdminCoupon | null, AdminCoupon>(CouponFormDialog, {
        data: coupon ?? null,
        width: '560px',
      })
      .closed.pipe(filter(Boolean))
      .subscribe(() => {
        this.notify.success(coupon ? 'Coupon saved' : 'Coupon created');
        this.load();
      });
  }

  protected toggle(coupon: AdminCoupon, checked: boolean): void {
    const set = (isActive: boolean) =>
      this.coupons.update((list) => list.map((c) => (c.id === coupon.id ? { ...c, isActive } : c)));
    set(checked);
    this.service.update(coupon.id, { isActive: checked }).subscribe({
      error: (err: unknown) => {
        set(!checked);
        this.notify.error(errorMessage(err));
      },
    });
  }

  protected remove(coupon: AdminCoupon): void {
    confirmed(
      this.bbDialog,
      {
        title: `Delete ${coupon.code}?`,
        message: 'Customers will no longer be able to use it.',
        confirmLabel: 'Delete',
        danger: true,
      },
      '420px',
    ).subscribe(() =>
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
