import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  FormRoot,
  TreeValidationResult,
  form,
  maxLength,
  pattern,
  required,
  validate,
} from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { IconComponent, ToggleComponent } from 'nexprime';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { AdminCouponService } from '../../../../core/services/checkout-api.service';
import { AdminCoupon, AdminCouponInput } from '../../../../shared/models/checkout.models';
import { rupeesToPaise } from '../../../../shared/pipes/money.pipes';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { numberRange } from '../../../../shared/forms/form-rules';

const startOfDay = (date: Date) => new Date(date).setHours(0, 0, 0, 0);

@Component({
  selector: 'bb-coupon-form-dialog',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    FormRoot,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    IconComponent,
  ],
  templateUrl: './coupon-form-dialog.html',
  styleUrl: './coupon-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CouponFormDialog {
  protected readonly data = inject<AdminCoupon | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<CouponFormDialog, AdminCoupon>);
  private readonly service = inject(AdminCouponService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);

  private readonly today = new Date();
  protected readonly model = signal({
    code: this.data?.code ?? '',
    description: this.data?.description ?? '',
    discountType: this.data?.discountType ?? ('percent' as 'percent' | 'flat'),
    discount: this.data
      ? this.data.discountType === 'percent'
        ? this.data.discountValue
        : this.data.discountValue / 100
      : (null as number | null),
    maxDiscount: this.data?.maxDiscountPaise
      ? this.data.maxDiscountPaise / 100
      : (null as number | null),
    minOrder: (this.data ? this.data.minOrderPaise / 100 : 0) as number | null,
    perUserLimit: (this.data?.perUserLimit ?? 1) as number | null,
    validFrom: new Date(this.data?.validFrom ?? this.today) as Date | null,
    validUntil: new Date(
      this.data?.validUntil ?? this.today.getTime() + 30 * 86_400_000,
    ) as Date | null,
    usageLimit: this.data?.usageLimit ?? (null as number | null),
    isActive: this.data?.isActive ?? true,
  });

  protected readonly form = form(
    this.model,
    (path) => {
      required(path.code, { message: 'Code is required' });
      pattern(path.code, /^[A-Za-z0-9_-]{3,30}$/, { message: '3-30 letters, digits, - or _' });
      maxLength(path.description, 200, { message: 'Description must be at most 200 characters' });
      numberRange(path.discount, 'Discount', 1, 10_000_000);
      validate(path.discount, ({ value, valueOf }) =>
        valueOf(path.discountType) === 'percent' && (value() ?? 0) > 100
          ? { kind: 'max', message: 'A percentage cannot exceed 100' }
          : undefined,
      );
      numberRange(path.maxDiscount, 'Max discount', 0, 10_000_000, { optional: true });
      numberRange(path.minOrder, 'Minimum order', 0, 10_000_000, { optional: true });
      numberRange(path.perUserLimit, 'Uses per customer', 1, 100);
      numberRange(path.usageLimit, 'Total uses', 1, 100_000_000, { optional: true });
      required(path.validFrom, { message: 'Start date is required' });
      required(path.validUntil, { message: 'End date is required' });
      validate(path.validUntil, ({ value, valueOf }) => {
        const from = valueOf(path.validFrom);
        return value() && from && startOfDay(value()!) < startOfDay(from)
          ? { kind: 'order', message: 'End date must be on or after the start date' }
          : undefined;
      });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    const percent = v.discountType === 'percent';
    const input: AdminCouponInput = {
      code: v.code.trim().toUpperCase(),
      description: v.description.trim(),
      discountType: v.discountType,
      discountValue: percent ? Math.round(Number(v.discount)) : rupeesToPaise(Number(v.discount)),
      maxDiscountPaise: percent && v.maxDiscount ? rupeesToPaise(Number(v.maxDiscount)) : null,
      minOrderPaise: rupeesToPaise(Number(v.minOrder ?? 0)),
      perUserLimit: Number(v.perUserLimit),
      // The whole of both days, in the admin's time zone.
      validFrom: new Date(startOfDay(v.validFrom!)).toISOString(),
      validUntil: new Date(startOfDay(v.validUntil!) + 86_400_000 - 1000).toISOString(),
      usageLimit: v.usageLimit ? Number(v.usageLimit) : null,
      isActive: v.isActive,
    };
    this.error.set(null);
    try {
      this.ref.close(
        await firstValueFrom(
          this.data ? this.service.update(this.data.id, input) : this.service.create(input),
        ),
      );
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
