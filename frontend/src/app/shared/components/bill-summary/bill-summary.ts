import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Pricing } from '../../models/checkout.models';
import { DistancePipe, InrPipe } from '../../pipes/money.pipes';

@Component({
  selector: 'bb-bill-summary',
  imports: [InrPipe, DistancePipe],
  templateUrl: './bill-summary.html',
  styleUrl: './bill-summary.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BillSummary {
  readonly pricing = input.required<Pricing>();
  readonly couponCode = input<string | undefined>();
  readonly distanceMeters = input<number | null | undefined>();
}
