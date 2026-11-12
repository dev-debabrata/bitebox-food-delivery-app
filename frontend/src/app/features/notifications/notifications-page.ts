import { NpIconPipe } from '../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatPaginatorModule } from '@angular/material/paginator';
import { InboxService } from '../../core/services/inbox.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PushSettings } from '../../shared/components/push-settings/push-settings';
import { pagedList } from '../../shared/list/paged-list';
import { AppNotification, notificationIcon } from '../../shared/models/payment.models';

@Component({
  selector: 'bb-notifications-page',
  imports: [
    DatePipe,
    MatButtonModule,
    MatButtonToggleModule,
    IconComponent,
    NpIconPipe,
    MatPaginatorModule,
    EmptyState,
    PageHeader,
    PushSettings,
  ],
  templateUrl: './notifications-page.html',
  styleUrl: './notifications-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationsPage {
  protected readonly inbox = inject(InboxService);
  protected readonly icon = notificationIcon;

  protected readonly tab = signal<'all' | 'unread'>('all');
  protected readonly list = pagedList(
    (page, limit) => this.inbox.page(page, limit, this.tab() === 'unread'),
    {
      filterKey: () => this.tab(),
      errorText: 'Could not load your notifications.',
    },
  );
  private readonly readHere = signal(new Set<string>());
  private readonly allReadHere = signal(false);

  constructor() {
    inject(RealtimeService)
      .notifications$.pipe(takeUntilDestroyed())
      .subscribe(() => this.list.load(1));
  }

  protected isUnread(n: AppNotification): boolean {
    return !n.readAt && !this.allReadHere() && !this.readHere().has(n.id);
  }

  protected open(n: AppNotification): void {
    if (this.isUnread(n)) this.readHere.update((s) => new Set(s).add(n.id));
    this.inbox.open(n);
  }

  protected markAllRead(): void {
    this.inbox.markAllRead();
    this.allReadHere.set(true);
  }
}
