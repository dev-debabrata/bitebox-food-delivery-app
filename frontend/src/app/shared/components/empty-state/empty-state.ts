import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** Friendly "nothing here" message with an optional action slot. */
@Component({
  selector: 'bb-empty-state',
  imports: [MatIconModule],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyState {
  readonly icon = input('search_off');
  readonly title = input.required<string>();
  readonly message = input<string>();
}
