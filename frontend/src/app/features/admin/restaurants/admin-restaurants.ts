import { IconComponent, PaginationComponent, TabsComponent } from 'nexprime';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  signal,
  computed,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { form } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Subscription, debounceTime, distinctUntilChanged, skip } from 'rxjs';
import { AdminCatalogService } from '../../../core/services/admin/admin-catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { Pagination } from '../../../shared/models/api.models';
import { AdminRestaurant, RestaurantStatus } from '../../../shared/models/catalog.models';
import { ImageFallback, UsableImagePipe } from '../../../shared/images/broken-images';

const TABS: { status: RestaurantStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'resubmission_requested', label: 'Documents needed' },
  { status: 'suspended', label: 'Suspended' },
];

@Component({
  selector: 'bb-admin-restaurants',
  imports: [
    DatePipe,
    NP_FORM_FIELDS,
    RouterLink,
    IconComponent,
    PaginationComponent,
    TabsComponent,
    EmptyState,
    PageHeader,
    ImageFallback,
    UsableImagePipe,
  ],
  templateUrl: './admin-restaurants.html',
  styleUrl: './admin-restaurants.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRestaurants implements OnInit {
  private readonly service = inject(AdminCatalogService);
  private readonly router = inject(Router);

  readonly status = input<RestaurantStatus>();

  protected readonly tabs = TABS;
  protected readonly activeTab = signal(0);
  protected readonly counts = signal<Record<RestaurantStatus, number> | null>(null);
  protected readonly restaurants = signal<AdminRestaurant[]>([]);
  protected readonly pagination = signal<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly filters = form(signal({ search: '' }));
  private inFlight?: Subscription;

  constructor() {
    toObservable(computed(() => this.filters.search().value().trim()))
      .pipe(skip(1), debounceTime(350), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(() => this.load(1));
  }

  ngOnInit(): void {
    const index = TABS.findIndex((t) => t.status === this.status());
    this.activeTab.set(index >= 0 ? index : 0);
    this.loadCounts();
    this.load(1);
  }

  /** The status tabs, with each status's count as the badge. */
  protected readonly tabItems = computed(() =>
    TABS.map((t) => ({
      id: t.status,
      label: t.label,
      content: '',
      badge: this.counts()?.[t.status],
    })),
  );

  protected selectTabId(id: string): void {
    const index = TABS.findIndex((t) => t.status === id);
    if (index >= 0 && index !== this.activeTab()) this.selectTab(index);
  }

  protected selectTab(index: number): void {
    this.activeTab.set(index);
    void this.router.navigate([], {
      queryParams: { status: TABS[index].status },
      replaceUrl: true,
    });
    this.load(1);
  }

  /** np-pagination: `(pageChange)` → goTo(page); `(rowsChange)` → goTo(1, rows). */
  protected goTo(page: number, rows?: number): void {
    if (rows) this.pagination.update((p) => ({ ...p, limit: rows }));
    this.load(page);
  }

  protected loadCounts(): void {
    this.service
      .restaurantCounts()
      .subscribe({ next: (c) => this.counts.set(c), error: () => this.counts.set(null) });
  }

  protected load(page: number): void {
    this.inFlight?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.inFlight = this.service
      .restaurants({
        status: TABS[this.activeTab()].status,
        search: this.filters.search().value().trim() || undefined,
        page,
        limit: this.pagination().limit,
      })
      .subscribe({
        next: (res) => {
          this.restaurants.set(res.items);
          this.pagination.set(res.pagination);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(errorMessage(err, 'Could not load restaurants.'));
          this.loading.set(false);
        },
      });
  }
}
