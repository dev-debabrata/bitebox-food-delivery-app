import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, ToggleComponent } from 'nexprime';
import { errorMessage } from '../../../core/services/api-error';
import {
  ChannelPreferences,
  NotificationCategory,
  NotificationPreferencesService,
} from '../../../core/services/notification-preferences.service';

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  orders: 'Orders and payments',
  account: 'Account and support',
  promotions: 'Offers and promotions',
};

/**
 * Email and SMS switches per category (Web Push has its own card). Email carries receipts,
 * refunds and account notices; SMS the delivery code and urgent order news, and is opt-in.
 */
@Component({
  selector: 'bb-channel-settings',
  imports: [IconComponent, ToggleComponent, RouterLink],
  templateUrl: './channel-settings.html',
  // The card, header and icon come from the push card; this file adds the two channel boxes.
  styleUrls: ['../push-settings/push-settings.scss', './channel-settings.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelSettings {
  private readonly api = inject(NotificationPreferencesService);
  protected readonly label = CATEGORY_LABEL;
  protected readonly channels = [
    { id: 'email', name: 'Email', icon: 'mail' },
    { id: 'sms', name: 'SMS', icon: 'message-square' },
  ] as const;

  protected readonly prefs = signal<ChannelPreferences | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal<string | null>(null);

  constructor() {
    this.api.get().subscribe({
      next: (p) => this.prefs.set(p),
      error: () => this.prefs.set(null), // older APIs: the card stays hidden
    });
  }

  /** Optimistic: flips the switch now and restores it if saving fails. */
  protected toggle(channel: 'email' | 'sms', category: NotificationCategory, on: boolean): void {
    const before = this.prefs();
    if (!before) return;
    const key = `${channel}.${category}`;
    this.prefs.set({
      ...before,
      channels: { ...before.channels, [channel]: { ...before.channels[channel], [category]: on } },
    });
    this.saving.set(key);
    this.error.set(null);
    this.api.update({ [channel]: { [category]: on } }).subscribe({
      next: (p) => {
        this.prefs.set(p);
        this.saving.set(null);
      },
      error: (err: unknown) => {
        this.prefs.set(before);
        this.saving.set(null);
        this.error.set(errorMessage(err, 'Could not save your choice.'));
      },
    });
  }
}
