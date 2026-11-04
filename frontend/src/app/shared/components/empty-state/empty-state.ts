import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'bb-empty-state',
  imports: [IconComponent, NpIconPipe],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyState {
  readonly icon = input('search_off');
  readonly title = input.required<string>();
  readonly message = input<string>();
}
