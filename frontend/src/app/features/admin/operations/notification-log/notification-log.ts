import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { finalize } from 'rxjs';
import { ButtonComponent, IconComponent, PaginationComponent, SelectOption } from 'nexprime';
import { errorMessage } from '../../../../core/services/api-error';
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationDeliveriesService,
  NotificationDelivery,
} from '../../../../core/services/notification-preferences.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';

const STATUS: Record<DeliveryStatus, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'tone-info' },
  sent: { label: 'Sent', tone: 'tone-good' },
  failed: { label: 'Retrying', tone: 'tone-warn' },
  dead: { label: 'Gave up', tone: 'tone-bad' },
  skipped: { label: 'Skipped', tone: '' },
};
const CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  push: 'Web push',
  fcm: 'App push',
  email: 'Email',
  sms: 'SMS',
};
const options = (any: string, labels: Record<string, string>): SelectOption[] => [
  { value: '', label: any },
  ...Object.entries(labels).map(([value, label]) => ({ value, label })),
];

/** What went out on push, email, SMS and app push; failures retry by themselves, dead ones here. */
@Component({
  selector: 'bb-notification-log',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    ButtonComponent,
    IconComponent,
    PaginationComponent,
    EmptyState,
    PageHeader,
  ],
  templateUrl: './notification-log.html',
  styleUrl: './notification-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationLog {
  private readonly api = inject(NotificationDeliveriesService);
  private readonly notify = inject(NotificationService);
  protected readonly status = STATUS;
  protected readonly channelLabel = CHANNEL_LABEL;

  protected readonly filterModel = signal({ status: 'dead', channel: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions = options(
    'Any status',
    Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])),
  );
  protected readonly channelOptions = options('Any channel', CHANNEL_LABEL);
  protected readonly retrying = signal<string | null>(null);

  protected readonly list = pagedList(
    (page, limit) => {
      const { status, channel } = this.filterModel();
      return this.api.list({
        status: (status || undefined) as DeliveryStatus | undefined,
        channel: (channel || undefined) as DeliveryChannel | undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => JSON.stringify(this.filterModel()),
      pollMs: 60_000,
      errorText: 'Could not load the notification log.',
    },
  );

  protected retry(d: NotificationDelivery): void {
    this.retrying.set(d.id);
    this.api
      .retry(d.id)
      .pipe(finalize(() => this.retrying.set(null)))
      .subscribe({
        next: (updated) => {
          if (updated.status === 'sent') this.notify.success('Sent');
          else this.notify.error(updated.lastError ?? 'It failed again. It will be retried.');
          this.list.reload();
        },
        error: (err: unknown) => this.notify.error(errorMessage(err)),
      });
  }
}
