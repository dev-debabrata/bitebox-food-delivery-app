import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonComponent, IconComponent, SelectComponent, SelectOption } from 'nexprime';
import { AdminOrdersService } from '../../../../../core/services/order-management.service';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../../shared/dialog/bb-dialog';
import { VEHICLE_LABEL } from '../../../../../shared/models/checkout.models';
import { AdminOrder } from '../../../../../shared/models/order-management.models';

/** Choose an online, free rider for a waiting order (manual assignment); closes with the id. */
@Component({
  selector: 'bb-assign-rider-dialog',
  imports: [BbDialogTitle, ButtonComponent, IconComponent, SelectComponent],
  templateUrl: './assign-rider-dialog.html',
  styleUrl: './assign-rider-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssignRiderDialog {
  protected readonly order = inject<AdminOrder>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<string>>(BbDialogRef);
  private readonly api = inject(AdminOrdersService);

  protected readonly riders = rxResource({
    stream: () => this.api.riders({ online: true, limit: 100 }),
  });
  /** Online riders who are not carrying an order and are not suspended. */
  protected readonly options = computed<SelectOption[]>(() =>
    (this.riders.value()?.items ?? [])
      .filter((r) => !r.activeOrder && r.status === 'active')
      .map((r) => ({
        value: r.id,
        label: [r.name, r.vehicleType ? VEHICLE_LABEL[r.vehicleType] : null, r.vehicleNumber]
          .filter(Boolean)
          .join(' · '),
      })),
  );
  protected readonly chosen = signal('');
}

export const pickRider = (dialog: BbDialog, order: AdminOrder) =>
  dialog.result<AssignRiderDialog, AdminOrder, string>(AssignRiderDialog, {
    data: order,
    width: '460px',
  });
