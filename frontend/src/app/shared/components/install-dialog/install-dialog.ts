import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { IconComponent } from 'nexprime';
import { detectPlatform } from '../../../core/services/platform-detector';
import { InstallPromptService } from '../../../core/services/install-prompt.service';

export type InstallTab = 'ios' | 'android' | 'desktop';
export type DesktopBrowser = 'chromium' | 'safari' | 'firefox';

@Component({
  selector: 'bb-install-dialog',
  imports: [MatDialogModule, MatButtonModule, IconComponent],
  templateUrl: './install-dialog.html',
  styleUrl: './install-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallDialog {
  private readonly ref = inject(MatDialogRef<InstallDialog>);
  protected readonly installer = inject(InstallPromptService, { optional: true });
  readonly platform = this.installer?.platform() ?? detectPlatform();

  readonly activeTab = signal<InstallTab>(
    this.platform.isIOS ? 'ios' : this.platform.isAndroid ? 'android' : 'desktop',
  );

  readonly desktopBrowser = signal<DesktopBrowser>(
    this.platform.isSafari ? 'safari' : this.platform.isFirefox ? 'firefox' : 'chromium',
  );

  readonly canInstallDirectly = computed(() => !!this.installer?.hasNativePrompt());

  setTab(tab: InstallTab): void {
    this.activeTab.set(tab);
  }

  setDesktopBrowser(browser: DesktopBrowser): void {
    this.desktopBrowser.set(browser);
  }

  async installNow(): Promise<void> {
    this.ref.close();
    if (this.installer) {
      await this.installer.install();
    }
  }

  close(): void {
    this.ref.close();
  }
}
