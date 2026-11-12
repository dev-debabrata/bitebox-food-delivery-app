import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { AuthService } from '../../../core/auth/auth.service';
import { InboxService } from '../../../core/services/inbox.service';
import { NotificationService } from '../../../core/services/notification.service';
import { notificationIcon } from '../../models/payment.models';
import { ROLE_META } from '../../models/user.models';
import { confirmed } from '../confirm-dialog/confirm-dialog';
import { BbDialog } from '../../dialog/bb-dialog';

@Component({
  selector: 'bb-notification-bell',
  imports: [DatePipe, RouterLink, MatButtonModule, IconComponent, NpIconPipe, MatMenuModule],
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationBell {
  protected readonly inbox = inject(InboxService);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  protected readonly icon = notificationIcon;
  protected readonly opened = signal(false);
  protected readonly badge = computed(() =>
    this.inbox.unread() > 99 ? '99+' : String(this.inbox.unread()),
  );
  protected readonly allLink = computed(() => {
    const role = this.auth.role();
    return role ? `${ROLE_META[role].home.replace(/\/$/, '')}/notifications` : '/notifications';
  });

  protected clearAll(): void {
    confirmed(this.dialog, {
      title: 'Clear all notifications?',
      message: 'This deletes all your notifications. It cannot be undone.',
      confirmLabel: 'Clear all',
      danger: true,
    }).subscribe(() =>
      this.inbox
        .clearAll()
        .subscribe({
          error: () => this.notify.error('Could not clear your notifications. Try again.'),
        }),
    );
  }
}
