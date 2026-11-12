import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { InstallPromptService } from '../../../core/services/install-prompt.service';

/**
 * "Install the BiteBox app" strip. Shown only where the browser supports installing, until it
 * is installed or the person chooses "Not now" (then it rests for a month).
 */
@Component({
  selector: 'bb-install-banner',
  imports: [MatButtonModule, IconComponent],
  templateUrl: './install-banner.html',
  styleUrl: './install-banner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallBanner {
  protected readonly installer = inject(InstallPromptService);
}
