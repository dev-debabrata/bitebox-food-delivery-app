import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageLoader } from './core/services/page-loader';
import { InstallPromptService } from './core/services/install-prompt.service';
import { PushNotificationService } from './core/services/push-notification.service';
import { ThemeService } from './core/services/theme.service';
import { AppStatus } from './shared/components/app-status/app-status';

@Component({
  imports: [RouterOutlet, AppStatus],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly loading = inject(PageLoader).visible;

  constructor() {
    // Started with the app (not with a lazy page): the install prompt can fire at any time,
    // and signing out must always unsubscribe this browser from push.
    inject(InstallPromptService);
    inject(PushNotificationService);
    // Keeps <html data-theme> in step with the stored choice and the device setting.
    inject(ThemeService);
  }
}
