import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import { IconComponent, SelectOption } from 'nexprime';
import { debounceTime, distinctUntilChanged, map, skip } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { AdminUsersService } from '../../../core/services/admin/admin-users.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Pagination } from '../../../shared/models/api.models';
import { ROLE_META, Role, User, UserStatus } from '../../../shared/models/user.models';

@Component({
  selector: 'bb-admin-users',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    MatButtonModule,
    IconComponent,
    MatPaginatorModule,
    MatTableModule,
    PageHeader,
  ],
  templateUrl: './admin-users.html',
  styleUrl: './admin-users.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsers implements OnInit {
  private readonly service = inject(AdminUsersService);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  readonly role = input<Role>();

  protected readonly roleMeta = ROLE_META;
  protected readonly roleLabel = (role: Role) => ROLE_META[role].label;
  /** Admin accounts are managed in Admin management, not here. */
  protected readonly roles: Role[] = ['customer', 'restaurant', 'delivery'];
  protected readonly columns = ['name', 'phone', 'role', 'status', 'createdAt', 'actions'];

  protected readonly currentUserId = computed(() => this.auth.user()?.id);
  protected readonly busyId = signal<string | null>(null);

  protected readonly roleOptions: SelectOption[] = [
    { value: '', label: 'All roles' },
    ...this.roles.map((r) => ({ value: r, label: ROLE_META[r].label })),
  ];

  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'suspended', label: 'Inactive' },
  ];

  protected readonly filters = form(
    signal({ search: '', role: '' as Role | '', status: '' as UserStatus | '' }),
  );

  protected readonly users = signal<User[]>([]);
  protected readonly pagination = signal<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly isDesktop = toSignal(
    inject(BreakpointObserver)
      .observe('(min-width: 768px)')
      .pipe(map((s) => s.matches)),
    { initialValue: true },
  );

  constructor() {
    toObservable(computed(() => this.filters.search().value().trim()))
      .pipe(skip(1), debounceTime(350), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => this.load(1));
    toObservable(this.filters.role().value)
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => this.load(1));
    toObservable(this.filters.status().value)
      .pipe(skip(1), takeUntilDestroyed())
      .subscribe(() => this.load(1));
  }

  ngOnInit(): void {
    const role = this.role();
    if (role && this.roles.includes(role)) this.filters.role().value.set(role);
    this.load(1);
  }

  protected onPage(event: PageEvent): void {
    this.pagination.update((p) => ({ ...p, limit: event.pageSize }));
    this.load(event.pageIndex + 1);
  }

  protected load(page: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.service
      .list({
        page,
        limit: this.pagination().limit,
        search: this.filters.search().value().trim() || undefined,
        role: this.filters.role().value() || undefined,
        status: this.filters.status().value() || undefined,
      })
      .subscribe({
        next: (res) => {
          this.users.set(res.items);
          this.pagination.set(res.pagination);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(errorMessage(err, 'Could not load users.'));
          this.loading.set(false);
        },
      });
  }

  protected toggleStatus(user: User): void {
    const suspend = user.status === 'active';
    confirmed(
      this.dialog,
      suspend
        ? {
            title: `Suspend ${user.name}?`,
            message: 'They will be signed out immediately and cannot sign in.',
            confirmLabel: 'Suspend',
            danger: true,
          }
        : {
            title: `Reactivate ${user.name}?`,
            message: 'They can sign in again.',
            confirmLabel: 'Reactivate',
          },
      '420px',
    ).subscribe(() => {
      this.busyId.set(user.id);
      this.service.setStatus(user.id, suspend ? 'suspended' : 'active').subscribe({
        next: (updatedUser) => {
          this.busyId.set(null);
          this.notify.success(suspend ? 'User suspended' : 'User reactivated');
          this.users.update((list) =>
            list.map((item) => (item.id === updatedUser.id ? { ...item, status: updatedUser.status } : item)),
          );
        },
        error: (err: unknown) => {
          this.busyId.set(null);
          this.notify.error(errorMessage(err, 'Failed to update user status'));
        },
      });
    });
  }
}
