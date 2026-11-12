import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { IconComponent, SelectOption, TabsComponent, ToggleComponent } from 'nexprime';
import { catchError, map, of } from 'rxjs';
import { OperationsService } from '../../../../core/services/admin/operations.service';
import { errorMessage } from '../../../../core/services/api-error';
import { liveRefresh } from '../../../../core/services/poll';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { Monitoring, RestaurantAvailability } from '../../../../shared/models/admin-roles.models';
import { ORDER_STATUS_LABEL, OrderStatus } from '../../../../shared/models/checkout.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';
import { openAdminOrder } from '../../orders/admin-order-dialog/admin-order-dialog';

type Loaded<T> = { data: T; error: null } | { data: null; error: string };
const loaded = <T>(data: T): Loaded<T> => ({ data, error: null });
const failed = <T>(err: unknown, text: string): Loaded<T> => ({
  data: null,
  error: errorMessage(err, text),
});

/** Live board of every order in progress (late ones first) and restaurant availability. */
@Component({
  selector: 'bb-order-monitoring',
  imports: [
    TableLabels,
    DatePipe,
    NP_FORM_FIELDS,
    ToggleComponent,
    TabsComponent,
    IconComponent,
    EmptyState,
    PageHeader,
    InrPipe,
  ],
  templateUrl: './order-monitoring.html',
  styleUrl: './order-monitoring.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderMonitoring {
  private readonly api = inject(OperationsService);
  private readonly dialog = inject(BbDialog);
  protected readonly statusLabel = ORDER_STATUS_LABEL;

  /** Re-read on every order event, with a 20 s fallback poll while the tab is visible. */
  private readonly board = toSignal(
    liveRefresh(
      () =>
        this.api.monitoring().pipe(
          map(loaded),
          catchError((err: unknown) => of(failed<Monitoring>(err, 'Could not load live orders.'))),
        ),
      { pollMs: 20_000, debounceMs: 500 },
    ),
  );
  protected readonly restaurants = toSignal(
    liveRefresh(
      () =>
        this.api.restaurants().pipe(
          map(loaded),
          catchError((err: unknown) =>
            of(failed<RestaurantAvailability[]>(err, 'Could not load restaurants.')),
          ),
        ),
      { pollMs: 60_000, debounceMs: 2000 },
    ),
  );

  protected readonly filterModel = signal({ status: '', lateOnly: false, search: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Every live status' },
    ...(
      [
        'pending',
        'confirmed',
        'preparing',
        'ready_for_pickup',
        'assigned',
        'arrived_at_restaurant',
        'picked_up',
        'on_the_way',
      ] as OrderStatus[]
    ).map((s) => ({ value: s, label: ORDER_STATUS_LABEL[s] })),
  ];

  protected readonly error = computed(() => this.board()?.error ?? null);
  protected readonly orders = computed(() => {
    const items = this.board()?.data?.items ?? [];
    const { status, lateOnly, search } = this.filterModel();
    const q = search.trim().toLowerCase();
    return items.filter(
      (o) =>
        (!status || o.status === status) &&
        (!lateOnly || o.late) &&
        (!q ||
          o.orderNumber.toLowerCase().includes(q) ||
          o.restaurantName?.toLowerCase().includes(q)),
    );
  });
  protected readonly lateCount = computed(
    () => this.board()?.data?.items.filter((o) => o.late).length ?? 0,
  );

  protected readonly tab = signal('live');
  protected readonly tabItems = computed(() => [
    {
      id: 'live',
      label: 'Live orders',
      content: '',
      badge: this.lateCount() ? `${this.lateCount()} late` : undefined,
    },
    { id: 'restaurants', label: 'Restaurant availability', content: '' },
  ]);
  protected readonly updatedAt = computed(() => this.board()?.data?.at ?? null);

  protected open(orderId: string): void {
    openAdminOrder(this.dialog, orderId).subscribe();
  }
}
