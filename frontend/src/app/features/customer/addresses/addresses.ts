import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { filter } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { AddressService } from '../../../core/services/checkout-api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { AddressFormDialog } from '../../../shared/components/address-form-dialog/address-form-dialog';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { DeliveryAddress } from '../../../shared/models/checkout.models';

@Component({
  selector: 'bb-addresses',
  imports: [TitleCasePipe, MatButtonModule, MatIconModule, MatMenuModule, EmptyState, PageHeader],
  templateUrl: './addresses.html',
  styleUrl: './addresses.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Addresses {
  private readonly service = inject(AddressService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly addresses = signal<DeliveryAddress[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.service.list().subscribe({
      next: (list) => {
        this.addresses.set(list);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load addresses.'));
        this.loading.set(false);
      },
    });
  }

  protected open(address?: DeliveryAddress): void {
    this.dialog
      .open<AddressFormDialog, DeliveryAddress | null, DeliveryAddress>(AddressFormDialog, { data: address ?? null, width: '640px', maxWidth: '95vw', autoFocus: 'first-tabbable' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
        this.notify.success(address ? 'Address updated' : 'Address saved');
        this.load();
      });
  }

  protected makeDefault(address: DeliveryAddress): void {
    this.service.setDefault(address.id).subscribe({
      next: () => this.load(),
      error: (err: unknown) => this.notify.error(errorMessage(err)),
    });
  }

  protected remove(address: DeliveryAddress): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: { title: 'Delete this address?', message: `${address.line1}, ${address.city}`, confirmLabel: 'Delete', danger: true },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.service.remove(address.id).subscribe({
          next: () => {
            this.notify.success('Address deleted');
            this.load();
          },
          error: (err: unknown) => this.notify.error(errorMessage(err)),
        }),
      );
  }
}
