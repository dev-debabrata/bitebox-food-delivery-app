import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'bb-empty-state',
  imports: [IconComponent, NpIconPipe],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `title` is an input; drop the static attribute so the host gets no browser tooltip.
  host: { '[attr.title]': 'null' },
})
export class EmptyState {
  readonly icon = input('search_off');
  readonly title = input.required<string>();
  readonly message = input<string>();
}
