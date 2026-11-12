import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  signal,
  computed,
} from '@angular/core';
import { form } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, ToggleComponent } from 'nexprime';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Subscription, debounceTime, distinctUntilChanged, filter, skip } from 'rxjs';
import {
  AdminCatalogService,
  AdminFoodItem,
} from '../../../core/services/admin/admin-catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import {
  ConfirmDialog,
  ConfirmDialogData,
} from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { Pagination } from '../../../shared/models/api.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

@Component({
  selector: 'bb-admin-foods',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    MatPaginatorModule,
    EmptyState,
    PageHeader,
    VegBadge,
    InrPipe,
  ],
  templateUrl: './admin-foods.html',
  styleUrl: './admin-foods.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminFoods implements OnInit {
  private readonly service = inject(AdminCatalogService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);

  readonly restaurant = input<string>();

  protected readonly filters = form(signal({ search: '' }));
  protected readonly items = signal<AdminFoodItem[]>([]);
  protected readonly pagination = signal<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private inFlight?: Subscription;

  constructor() {
    toObservable(computed(() => this.filters.search().value().trim()))
      .pipe(skip(1), debounceTime(350), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => this.load(1));
  }

  ngOnInit(): void {
    this.load(1);
  }

  protected clearRestaurant(): void {
    void this.router.navigate([], { queryParams: {} }).then(() => this.load(1));
  }

  protected onPage(event: PageEvent): void {
    this.pagination.update((p) => ({ ...p, limit: event.pageSize }));
    this.load(event.pageIndex + 1);
  }

  protected load(page: number): void {
    this.inFlight?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.inFlight = this.service
      .foods({
        search: this.filters.search().value().trim() || undefined,
        restaurant: this.restaurant() || undefined,
        page,
        limit: this.pagination().limit,
      })
      .subscribe({
        next: (res) => {
          this.items.set(res.items);
          this.pagination.set(res.pagination);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(errorMessage(err, 'Could not load dishes.'));
          this.loading.set(false);
        },
      });
  }

  protected toggle(item: AdminFoodItem, checked: boolean): void {
    const set = (isAvailable: boolean) =>
      this.items.update((list) => list.map((i) => (i.id === item.id ? { ...i, isAvailable } : i)));
    set(checked);
    this.service.setFoodAvailability(item.id, checked).subscribe({
      error: (err: unknown) => {
        set(!checked);
        this.notify.error(errorMessage(err));
      },
    });
  }

  protected remove(item: AdminFoodItem): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: {
          title: `Delete “${item.name}”?`,
          message: `This removes it from ${item.restaurant.name}'s menu.`,
          confirmLabel: 'Delete',
          danger: true,
        },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.service.deleteFood(item.id).subscribe({
          next: () => {
            this.items.update((list) => list.filter((i) => i.id !== item.id));
            this.notify.success('Dish deleted');
          },
          error: (err: unknown) => this.notify.error(errorMessage(err)),
        }),
      );
  }
}
