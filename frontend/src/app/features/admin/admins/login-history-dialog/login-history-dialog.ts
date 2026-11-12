import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ButtonComponent, IconComponent, PaginationComponent } from 'nexprime';
import { AdminStaffService } from '../../../../core/services/admin/admin-staff.service';
import { errorMessage } from '../../../../core/services/api-error';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';
import { LoginEntry } from '../../../../shared/models/admin-roles.models';
import { Pagination } from '../../../../shared/models/api.models';
import { User } from '../../../../shared/models/user.models';

const ENDED: Record<string, string> = {
  logout: 'Signed out',
  expired: 'Expired',
  rotated: 'Expired',
  reuse: 'Ended: token reuse detected',
  'password-change': 'Ended: password changed',
  suspended: 'Ended: account suspended',
  'role-change': 'Ended: role changed',
};

/** A staff admin's sign-ins (master prompt §3D, admin security: login history). */
@Component({
  selector: 'bb-login-history-dialog',
  imports: [DatePipe, BbDialogTitle, ButtonComponent, IconComponent, PaginationComponent],
  templateUrl: './login-history-dialog.html',
  styleUrl: './login-history-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginHistoryDialog {
  protected readonly user = inject<User>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<void>>(BbDialogRef);
  private readonly api = inject(AdminStaffService);

  protected readonly items = signal<LoginEntry[] | null>(null);
  protected readonly pagination = signal<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);

  constructor() {
    this.load(1);
  }

  protected load(page: number, rows?: number): void {
    const limit = rows ?? this.pagination().limit;
    this.loading.set(true);
    this.error.set(null);
    this.api.logins(this.user.id, page, limit).subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.pagination.set(res.pagination);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(
          err instanceof HttpErrorResponse && err.status === 404
            ? 'Sign-in history is available once the app runs on the new (Django) API.'
            : errorMessage(err, 'Could not load the sign-in history.'),
        );
        this.loading.set(false);
      },
    });
  }

  protected ended(entry: LoginEntry): string {
    return ENDED[entry.endedReason ?? ''] ?? 'Ended';
  }

  /** "Chrome on Windows"-style summary of a user agent; the full string is in the title. */
  protected device(ua: string): string {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
    const os = /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
    return os ? `${browser} on ${os}` : ua.slice(0, 40);
  }
}

export const openLoginHistory = (dialog: BbDialog, user: User) =>
  dialog.open<LoginHistoryDialog, User, void>(LoginHistoryDialog, { data: user, width: '560px' });
