import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { resourceError } from '../../../../core/services/api-error';
import { SupportDeskService } from '../../../../core/services/support.service';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';

@Component({
  selector: 'bb-support-dashboard',
  imports: [RouterLink, MatButtonModule, IconComponent, PageHeader, StatTile],
  templateUrl: './support-dashboard.html',
  styleUrl: './support-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportDashboardPage {
  private readonly api = inject(SupportDeskService);
  protected readonly stats = rxResource({ stream: () => this.api.dashboard() });
  protected readonly error = resourceError(this.stats, 'Could not load support figures.');
}
