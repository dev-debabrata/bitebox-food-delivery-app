import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { RouterLink } from '@angular/router';
import { IconComponent, ToggleComponent } from 'nexprime';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import {
  MyRestaurantService,
  MyRestaurantState,
  RestaurantStats,
} from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RealtimeService } from '../../../core/services/realtime.service';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { ClockTimePipe } from '../../../shared/pipes/clock-time.pipe';
import { StatusBanner } from '../status-banner/status-banner';
import { StatTile } from '../../../shared/components/stat-tile/stat-tile';
import { ImageFallback, UsableImagePipe } from '../../../shared/images/broken-images';

@Component({
  selector: 'bb-restaurant-dashboard',
  imports: [ToggleComponent, RouterLink, IconComponent, StatTile, InrPipe, ClockTimePipe, StatusBanner, ImageFallback, UsableImagePipe],
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
  protected readonly orderStats = signal<RestaurantStats | null>(null);
  protected readonly statsError = signal<string | null>(null);
  /** The API has no /my/restaurant/stats (the Node API; Django has it): hide the figures. */
  protected readonly statsUnavailable = signal(false);

  constructor() {
    this.load();
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
      next: (state) => {
        this.state.set(state);
        if (state.restaurant) this.loadStats();
      },
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load your restaurant.')),
    });
  }

  protected loadStats(): void {
    this.statsError.set(null);
    this.service.stats().subscribe({
      next: (stats) => this.orderStats.set(stats),
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 404) this.statsUnavailable.set(true);
        else this.statsError.set(errorMessage(err, 'Could not load your order figures.'));
      },
    });
  }

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
