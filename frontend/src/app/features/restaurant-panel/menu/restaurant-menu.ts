import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, filter, of } from 'rxjs';
import { CatalogService } from '../../../core/services/catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { MyRestaurantService } from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { FoodItem, categoryIdOf } from '../../../shared/models/catalog.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { FoodFormDialog, FoodFormData } from '../food-form-dialog/food-form-dialog';

type AvailabilityFilter = 'all' | 'available' | 'unavailable';

import { form } from '@angular/forms/signals';
import {
  ButtonComponent,
  IconComponent,
  MenuComponent,
  type MenuItem,
  SelectOption,
  ToggleComponent,
} from 'nexprime';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { ImageFallback, UsableImagePipe } from '../../../shared/images/broken-images';
import { BbDialog } from '../../../shared/dialog/bb-dialog';
import {
  COMPACT_MENU_WIDTH,
  toggleEndAligned,
} from '../../../shared/menu/end-aligned-menu';

@Component({
  selector: 'bb-restaurant-menu',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    RouterLink,
    ButtonComponent,
    IconComponent,
    NpIconPipe,
    MenuComponent,
    EmptyState,
    PageHeader,
    VegBadge,
    InrPipe,
    ImageFallback,
    UsableImagePipe,
  ],
  templateUrl: './restaurant-menu.html',
  styleUrl: './restaurant-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantMenu implements OnInit {
  private readonly service = inject(MyRestaurantService);
  private readonly bbDialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  readonly available = input<string>();

  protected readonly categories = toSignal(
    inject(CatalogService)
      .categories()
      .pipe(catchError(() => of([]))),
    { initialValue: [] },
  );
  protected readonly items = signal<FoodItem[]>([]);
  protected readonly toggleMenu = (menu: MenuComponent, event: Event) =>
    toggleEndAligned(menu, event, COMPACT_MENU_WIDTH);
  /** Each dish's actions menu (built once per list change, not on every render). */
  protected readonly menus = computed(
    () =>
      new Map<string, MenuItem[]>(
        this.items().map((item) => [
          item.id,
          [
            { label: 'Edit', icon: 'pencil', command: () => this.openForm(item) },
            { label: 'Delete', icon: 'trash-2', command: () => this.remove(item) },
          ],
        ]),
      ),
  );
  protected readonly loading = signal(true);
  protected readonly noRestaurant = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);
  protected readonly total = signal(0);

  protected readonly filterModel = signal({
    search: '',
    category: '',
    availability: 'all' as AvailabilityFilter,
  });
  protected readonly filters = form(this.filterModel);
  protected readonly categoryOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'All categories' },
    ...this.categories().map((c) => ({ value: c.id, label: c.name })),
  ]);
  protected readonly availabilityOptions: SelectOption[] = [
    { value: 'all', label: 'All dishes' },
    { value: 'available', label: 'Available' },
    { value: 'unavailable', label: 'Unavailable' },
  ];

  protected readonly filtered = computed(() => {
    const { search, category, availability } = this.filterModel();
    const term = search.trim().toLowerCase();
    return this.items().filter(
      (i) =>
        (!term || i.name.toLowerCase().includes(term)) &&
        (!category || categoryIdOf(i) === category) &&
        (availability === 'all' || (availability === 'available') === i.isAvailable),
    );
  });

  constructor() {
    this.load();
  }

  ngOnInit(): void {
    if (this.available() === 'true') this.filters.availability().value.set('available');
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.foods({ limit: 100 }).subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.total.set(res.pagination.total);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 404) this.noRestaurant.set(true);
        else this.error.set(errorMessage(err, 'Could not load your menu.'));
        this.loading.set(false);
      },
    });
  }

  protected openForm(item?: FoodItem): void {
    this.bbDialog
      .open<FoodFormDialog, FoodFormData, FoodItem>(FoodFormDialog, {
        data: { item, categories: this.categories() },
        width: '560px',
      })
      .closed
      .pipe(filter((saved): saved is FoodItem => !!saved))
      .subscribe((saved) => {
        this.items.update((list) =>
          item
            ? list.map((i) => (i.id === saved.id ? saved : i))
            : [...list, saved].sort((a, b) => a.name.localeCompare(b.name)),
        );
        this.notify.success(item ? 'Dish saved' : 'Dish added to your menu');
      });
  }

  protected toggleAvailability(item: FoodItem, checked: boolean): void {
    const set = (isAvailable: boolean) =>
      this.items.update((list) => list.map((i) => (i.id === item.id ? { ...i, isAvailable } : i)));
    set(checked);
    this.busyId.set(item.id);
    this.service.setFoodAvailability(item.id, checked).subscribe({
      next: () => this.busyId.set(null),
      error: (err: unknown) => {
        set(!checked);
        this.notify.error(errorMessage(err));
        this.busyId.set(null);
      },
    });
  }

  protected remove(item: FoodItem): void {
    confirmed(
      this.bbDialog,
      {
        title: `Delete “${item.name}”?`,
        message: 'Customers will no longer see this dish.',
        confirmLabel: 'Delete',
        danger: true,
      },
      '420px',
    ).subscribe(() => {
      this.busyId.set(item.id);
      this.service.deleteFood(item.id).subscribe({
        next: () => {
          this.items.update((list) => list.filter((i) => i.id !== item.id));
          this.notify.success('Dish deleted');
          this.busyId.set(null);
        },
        error: (err: unknown) => {
          this.notify.error(errorMessage(err));
          this.busyId.set(null);
        },
      });
    });
  }
}
