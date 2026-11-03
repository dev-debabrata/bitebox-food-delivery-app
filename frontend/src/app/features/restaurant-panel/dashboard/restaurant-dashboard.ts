import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent, ToggleComponent } from 'nexprime';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import {
  MyRestaurantService,
  MyRestaurantState,
} from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RealtimeService } from '../../../core/services/realtime.service';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { StatusBanner } from '../status-banner/status-banner';

@Component({
  selector: 'bb-restaurant-dashboard',
  imports: [ToggleComponent, RouterLink, MatButtonModule, IconComponent, InrPipe, StatusBanner],
  templateUrl: './restaurant-dashboard.html',
  styleUrl: './restaurant-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantDashboard {
  private readonly service = inject(MyRestaurantService);
  private readonly notify = inject(NotificationService);
  protected readonly user = inject(AuthService).user;

  protected readonly state = signal<MyRestaurantState | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly toggling = signal(false);

  constructor() {
    this.load();
    // An admin approved, rejected or suspended the restaurant: show the new status at once.
    inject(RealtimeService)
      .notifications$.pipe(
        filter((n) => n.type.startsWith('restaurant.')),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.load());
  }

  protected load(): void {
    this.error.set(null);
    this.service.get().subscribe({
      next: (state) => this.state.set(state),
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load your restaurant.')),
    });
  }

  /** Optimistic: the switch follows the state; on failure the state (and so the switch) goes back. */
  protected toggleOrders(checked: boolean): void {
    const set = (isAcceptingOrders: boolean) =>
      this.state.update((s) =>
        s?.restaurant ? { ...s, restaurant: { ...s.restaurant, isAcceptingOrders } } : s,
      );
    set(checked);
    this.toggling.set(true);
    this.service.setAcceptingOrders(checked).subscribe({
      next: (restaurant) => {
        this.state.update((s) => (s ? { ...s, restaurant } : s));
        this.notify.success(
          restaurant.isAcceptingOrders ? 'You are accepting orders' : 'Orders paused',
        );
        this.toggling.set(false);
      },
      error: (err: unknown) => {
        set(!checked);
        this.notify.error(errorMessage(err));
        this.toggling.set(false);
      },
    });
  }
}
