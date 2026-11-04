import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ORDER_STATUS_LABEL, OrderStatus } from '../../models/checkout.models';

const TONE: Record<OrderStatus, string> = {
  pending: 'waiting',
  confirmed: 'cooking',
  preparing: 'cooking',
  ready_for_pickup: 'handover',
  assigned: 'handover',
  picked_up: 'road',
  on_the_way: 'road',
  delivered: 'done',
  rejected: 'stopped',
  cancelled: 'stopped',
};

@Component({
  selector: 'bb-order-status-chip',
  templateUrl: './order-status-chip.html',
  styleUrl: './order-status-chip.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"tone-" + tone()' },
})
export class OrderStatusChip {
  readonly status = input.required<OrderStatus>();
  readonly label = input<string>();
  protected readonly tone = computed(() => TONE[this.status()]);
  protected readonly text = computed(() => this.label() ?? ORDER_STATUS_LABEL[this.status()]);
}
