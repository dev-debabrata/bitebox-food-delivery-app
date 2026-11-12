import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { OperationsService } from '../../../../core/services/admin/operations.service';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { periodReport } from '../../../../shared/list/period-report';
import { ORDER_STATUS_LABEL, OrderStatus } from '../../../../shared/models/checkout.models';

const LIVE_ORDER: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'assigned',
  'picked_up',
  'on_the_way',
];

@Component({
  selector: 'bb-operations-dashboard',
  imports: [RouterLink, MatButtonModule, IconComponent, NP_FORM_FIELDS, PageHeader, StatTile],
  templateUrl: './operations-dashboard.html',
  styleUrl: './operations-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationsDashboardPage {
  private readonly api = inject(OperationsService);
  protected readonly report = periodReport((days) => this.api.dashboard(days), 'Could not load the dashboard.');

  /** Live orders per status, as bars against the busiest status. */
  protected readonly live = computed(() => {
    const byStatus = this.report.data()?.orders.byStatus ?? {};
    const max = Math.max(1, ...LIVE_ORDER.map((s) => byStatus[s] ?? 0));
    return LIVE_ORDER.map((s) => ({
      status: s,
      label: ORDER_STATUS_LABEL[s],
      count: byStatus[s] ?? 0,
      share: (byStatus[s] ?? 0) / max,
    }));
  });
}
