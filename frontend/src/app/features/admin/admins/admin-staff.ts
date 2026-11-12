import { TableLabels } from '../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IconComponent, SelectOption } from 'nexprime';
import { AuthService } from '../../../core/auth/auth.service';
import { AdminStaffService } from '../../../core/services/admin/admin-staff.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  ADMIN_ROLES,
  AdminRole,
  ROLE_META,
  STAFF_ADMIN_ROLES,
  User,
  UserStatus,
} from '../../../shared/models/user.models';
import { openStaffForm } from './staff-form-dialog/staff-form-dialog';

/** Super admin: create operations, finance and support admins and manage their access. */
@Component({
  selector: 'bb-admin-staff',
  imports: [
    TableLabels,
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    MatTooltipModule,
    IconComponent,
    EmptyState,
    PageHeader,
  ],
  templateUrl: './admin-staff.html',
  styleUrl: './admin-staff.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminStaff {
  private readonly api = inject(AdminStaffService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);
  protected readonly me = computed(() => this.auth.user()?.id);
  protected readonly roleLabel = (role: string) => ROLE_META[role as AdminRole]?.label ?? role;
  protected readonly isStaff = (u: User) => (STAFF_ADMIN_ROLES as readonly string[]).includes(u.role);
  protected readonly busy = signal<string | null>(null);

  protected readonly filterModel = signal({ search: '', role: '', status: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly roleOptions: SelectOption[] = [
    { value: '', label: 'All admin roles' },
    ...ADMIN_ROLES.map((r) => ({ value: r, label: ROLE_META[r].label })),
  ];
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Active and inactive' },
    { value: 'active', label: 'Active' },
    { value: 'suspended', label: 'Inactive' },
  ];

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.list({
        search: f.search.trim() || undefined,
        role: (f.role || undefined) as AdminRole | undefined,
        status: (f.status || undefined) as UserStatus | undefined,
        page,
        limit,
      });
    },
    { filterKey: () => JSON.stringify(this.filterModel()), errorText: 'Could not load admins.' },
  );

  protected create(): void {
    openStaffForm(this.dialog, null).subscribe((user) => {
      if (!user) return;
      this.notify.success(`${user.name} can now sign in as ${this.roleLabel(user.role)}`);
      this.list.load(1);
    });
  }

  protected edit(user: User): void {
    openStaffForm(this.dialog, user).subscribe((saved) => {
      if (!saved) return;
      this.notify.success('Admin updated');
      this.list.reload();
    });
  }

  protected toggle(user: User): void {
    const activate = user.status !== 'active';
    confirmed(this.dialog, {
      title: activate ? `Activate ${user.name}?` : `Deactivate ${user.name}?`,
      message: activate
        ? 'They can sign in again with their existing password.'
        : 'They are signed out everywhere and cannot sign in until you activate them again.',
      confirmLabel: activate ? 'Activate' : 'Deactivate',
      danger: !activate,
    }).subscribe(() => {
      this.busy.set(user.id);
      this.api.setStatus(user.id, activate ? 'active' : 'suspended').subscribe({
        next: () => {
          this.busy.set(null);
          this.notify.success(activate ? 'Admin activated' : 'Admin deactivated');
          this.list.reload();
        },
        error: (err: unknown) => {
          this.busy.set(null);
          this.notify.error(errorMessage(err));
        },
      });
    });
  }
}
