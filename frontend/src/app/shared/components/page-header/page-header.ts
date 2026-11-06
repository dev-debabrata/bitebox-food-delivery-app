import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'bb-page-header',
  templateUrl: './page-header.html',
  styleUrl: './page-header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `title` is an input; drop the static attribute so the host gets no browser tooltip.
  host: { '[attr.title]': 'null' },
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
