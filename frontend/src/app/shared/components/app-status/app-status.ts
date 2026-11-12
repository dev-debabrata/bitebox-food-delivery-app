import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { AppUpdateService } from '../../../core/services/app-update.service';
import { ConnectionStatus } from '../../../core/services/connection-status.service';
import { InstallPromptService } from '../../../core/services/install-prompt.service';

/**
 * App-wide PWA status, pinned to the bottom of the screen: the offline indicator, the
 * "Back online" confirmation, the "installed" confirmation and the "New version available"
 * prompt. Loaded with `@defer` so Material and NexPrime stay out of the initial bundle.
 */
@Component({
  selector: 'bb-app-status',
  imports: [MatButtonModule, IconComponent],
  templateUrl: './app-status.html',
  styleUrl: './app-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppStatus {
  protected readonly connection = inject(ConnectionStatus);
  protected readonly update = inject(AppUpdateService);
  protected readonly installer = inject(InstallPromptService);
}
