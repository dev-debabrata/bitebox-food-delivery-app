import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, ToggleComponent } from 'nexprime';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { storageGet, storageSet } from '../../../core/services/browser-storage';
import { NotificationService } from '../../../core/services/notification.service';
import {
  PushCategory,
  PushNotificationService,
  PushSettings as Settings,
} from '../../../core/services/push-notification.service';

const PROMPT_DISMISSED_KEY = 'bb.push.promptDismissedAt';
const PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

interface CategoryText {
  label: string;
  hint: string;
}

/**
 * Browser push notifications: explains what they are for before the browser asks, turns them on
 * or off for this device, and edits the account's push preferences.
 *
 * `compact`: a small "Get order updates" card for contextual places (the order page). It only
 * shows while push can be turned on here, and "Not now" hides it for two weeks.
 */
@Component({
  selector: 'bb-push-settings',
  imports: [MatButtonModule, IconComponent, ToggleComponent],
  templateUrl: './push-settings.html',
  styleUrl: './push-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PushSettings {
  readonly compact = input(false);

  protected readonly push = inject(PushNotificationService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly settings = signal<Settings | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly saving = signal<PushCategory | null>(null);
  protected readonly snoozed = signal(true);

  protected readonly isCustomer = computed(() => this.auth.user()?.role === 'customer');
  /** Compact mode: the server has push configured (checked only when a prompt could show). */
  private readonly serverOn = signal(false);

  /** The compact prompt: push can be turned on here and nobody said no yet. */
  protected readonly showPrompt = computed(
    () => !this.snoozed() && this.push.permission() === 'default' && this.serverOn(),
  );

  protected readonly text = computed<Record<PushCategory, CategoryText>>(() => ({
    orders: this.isCustomer()
      ? {
          label: 'Order updates',
          hint: 'Confirmed, being prepared, picked up, out for delivery and delivered.',
        }
      : { label: 'Orders and deliveries', hint: 'New orders, delivery requests and status changes.' },
    account: {
      label: 'Account and support',
      hint: this.isCustomer()
        ? 'Replies to your support requests, reviews, coins and rewards.'
        : 'Support replies, reviews and account alerts.',
    },
    promotions: {
      label: 'Offers and promotions',
      hint: 'Occasional deals from BiteBox. Off unless you turn it on.',
    },
  }));

  constructor() {
    afterNextRender(() => {
      this.snoozed.set(Date.now() - Number(storageGet(PROMPT_DISMISSED_KEY) || 0) < PROMPT_SNOOZE_MS);
      if (!this.push.supported) return;
      if (!this.compact()) void this.load();
      else if (!this.snoozed() && this.push.permission() === 'default')
        this.push.available().then((on) => this.serverOn.set(on), () => undefined);
    });
  }

  protected async load(): Promise<void> {
    this.loadError.set(null);
    try {
      this.settings.set(await this.push.settings());
    } catch (error) {
      this.loadError.set(errorMessage(error, 'Could not load your notification settings.'));
    }
  }

  /** Runs from the "Turn on" click: this is when the browser shows its permission prompt. */
  protected async enable(): Promise<void> {
    this.actionError.set(null);
    try {
      await this.push.enable();
      this.notify.success("Notifications are on. We'll keep you posted on this device.");
      if (!this.compact()) void this.load();
    } catch (error) {
      if (this.push.permission() === 'denied') return; // the blocked state explains what to do
      if (this.push.permission() === 'default') {
        this.actionError.set('Notifications were not turned on. You can try again any time.');
        return;
      }
      this.actionError.set(
        errorMessage(error, error instanceof Error ? error.message : 'Could not turn on notifications.'),
      );
    }
  }

  protected async disable(): Promise<void> {
    this.actionError.set(null);
    await this.push.disable();
    this.notify.info('Notifications are off on this device.');
    void this.load();
  }

  /** np-toggle is bound to the saved state and updated optimistically (restored on failure). */
  protected async toggle(category: PushCategory, on: boolean): Promise<void> {
    const before = this.settings();
    if (!before || before.preferences[category] === on) return;
    this.settings.set({ ...before, preferences: { ...before.preferences, [category]: on } });
    this.saving.set(category);
    try {
      this.settings.set(await this.push.savePreferences({ [category]: on }));
    } catch (error) {
      this.settings.set(before);
      this.notify.error(errorMessage(error, 'Could not save that change.'));
    } finally {
      this.saving.set(null);
    }
  }

  protected notNow(): void {
    this.snoozed.set(true);
    storageSet(PROMPT_DISMISSED_KEY, String(Date.now()));
  }
}
