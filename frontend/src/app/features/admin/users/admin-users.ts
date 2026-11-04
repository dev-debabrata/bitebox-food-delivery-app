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
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTableModule } from '@angular/material/table';
import { IconComponent, SelectOption } from 'nexprime';
import { debounceTime, distinctUntilChanged, map, skip } from 'rxjs';
import { AdminUsersService } from '../../../core/services/admin/admin-users.service';
import { errorMessage } from '../../../core/services/api-error';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Pagination } from '../../../shared/models/api.models';
import { ROLE_META, Role, User } from '../../../shared/models/user.models';

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

  readonly role = input<Role>();

  protected readonly roleMeta = ROLE_META;
  protected readonly roleLabel = (role: Role) => ROLE_META[role].label;
  protected readonly roles = Object.keys(ROLE_META) as Role[];
  protected readonly columns = ['name', 'phone', 'role', 'status', 'createdAt'];

  protected readonly roleOptions: SelectOption[] = [
    { value: '', label: 'All roles' },
    ...this.roles.map((r) => ({ value: r, label: ROLE_META[r].label })),
  ];

  protected readonly filters = form(signal({ search: '', role: '' as Role | '' }));

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
}
