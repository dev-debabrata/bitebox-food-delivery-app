import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Restaurant } from '../../models/catalog.models';
import { DistancePipe, InrPipe } from '../../pipes/money.pipes';

/** Restaurant tile used in listings. Falls back to a branded illustration when there is no photo. */
@Component({
  selector: 'bb-restaurant-card',
  imports: [RouterLink, MatIconModule, InrPipe, DistancePipe],
  templateUrl: './restaurant-card.html',
  styleUrl: './restaurant-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestaurantCard {
  readonly restaurant = input.required<Restaurant>();

  protected readonly rating = computed(() => {
    const { average, count } = this.restaurant().rating;
    return count > 0 ? average.toFixed(1) : null;
  });
  protected readonly locality = computed(() => {
    const { area, city } = this.restaurant().address;
    return [area, city].filter(Boolean).join(', ');
  });
}
