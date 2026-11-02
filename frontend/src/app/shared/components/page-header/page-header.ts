import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Page title + optional subtitle, with a slot for actions on the right. */
@Component({
  selector: 'bb-page-header',
  templateUrl: './page-header.html',
  styleUrl: './page-header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
