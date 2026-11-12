import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ButtonComponent, SelectComponent, SelectOption } from 'nexprime';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';
import { RestaurantOrder } from '../../../../shared/models/order-management.models';

const CHOICES = [10, 15, 20, 25, 30, 40, 45, 60, 75, 90];

/** Accept an order with a preparation time (master prompt §3B); closes with the minutes. */
@Component({
  selector: 'bb-accept-dialog',
  imports: [BbDialogTitle, ButtonComponent, SelectComponent],
  templateUrl: './accept-dialog.html',
  styleUrl: './accept-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AcceptDialog {
  protected readonly order = inject<RestaurantOrder>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<number>>(BbDialogRef);
  protected readonly options: SelectOption[] = CHOICES.map((m) => ({
    value: String(m),
    label: `${m} minutes`,
  }));
  protected readonly minutes = signal(20);

  protected pick(value: unknown): void {
    const m = Number(value);
    if (m) this.minutes.set(m);
  }
}

export const askPrepTime = (dialog: BbDialog, order: RestaurantOrder) =>
  dialog.result<AcceptDialog, RestaurantOrder, number>(AcceptDialog, {
    data: order,
    width: '460px',
  });
