import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** "– 2 +" control. Shows an ADD button when the quantity is 0. */
@Component({
  selector: 'bb-qty-stepper',
  imports: [IconComponent],
  templateUrl: './qty-stepper.html',
  styleUrl: './qty-stepper.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QtyStepper {
  readonly quantity = input.required<number>();
  readonly label = input('item');
  readonly disabled = input(false);
  readonly max = input(20);
  readonly add = output<void>();
  readonly changed = output<number>();
}
