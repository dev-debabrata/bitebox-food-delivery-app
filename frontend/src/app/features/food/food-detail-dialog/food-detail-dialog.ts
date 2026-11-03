import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { FoodItem } from '../../../shared/models/catalog.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

export interface FoodDetailData {
  item: Pick<FoodItem, 'name' | 'description' | 'pricePaise' | 'isVeg' | 'isAvailable' | 'imageUrl' | 'prepTimeMinutes' | 'tags'> & {
    category: { name: string; icon: string } | null;
  };
  restaurant: { name: string; slug: string; isOpenNow?: boolean };
  /** Show a link to the restaurant page (hidden when already on it). */
  showRestaurantLink?: boolean;
}

/** Food item details and availability. Adding to cart arrives with the cart (Phase 3). */
@Component({
  selector: 'bb-food-detail-dialog',
  imports: [RouterLink, MatDialogModule, MatButtonModule, IconComponent, NpIconPipe, VegBadge, InrPipe],
  templateUrl: './food-detail-dialog.html',
  styleUrl: './food-detail-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodDetailDialog {
  protected readonly data = inject<FoodDetailData>(MAT_DIALOG_DATA);
}
