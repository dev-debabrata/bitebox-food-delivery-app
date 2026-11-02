import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { ToggleComponent } from 'nexprime';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { MyRestaurantService, MyRestaurantState } from '../../../core/services/my-restaurant.service';
import { NotificationService } from '../../../core/services/notification.service';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { StatusBanner } from '../status-banner/status-banner';

@Component({
  selector: 'bb-restaurant-dashboard',
  imports: [ToggleComponent, RouterLink, MatButtonModule, MatIconModule, InrPipe, StatusBanner],
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
  }

  protected load(): void {
    this.error.set(null);
    this.service.get().subscribe({
      next: (state) => this.state.set(state),
      error: (err: unknown) => this.error.set(errorMessage(err, 'Could not load your restaurant.')),
    });
  }

  protected toggleOrders(checked: boolean, toggle: ToggleComponent): void {
    this.toggling.set(true);
    this.service.setAcceptingOrders(checked).subscribe({
      next: (restaurant) => {
        this.state.update((s) => (s ? { ...s, restaurant } : s));
        this.notify.success(restaurant.isAcceptingOrders ? 'You are accepting orders' : 'Orders paused');
        this.toggling.set(false);
      },
      error: (err: unknown) => {
        toggle.checked.set(!checked); // back to what the server has
        this.notify.error(errorMessage(err));
        this.toggling.set(false);
      },
    });
  }
}
