import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { VegBadge } from '../../../shared/components/veg-badge/veg-badge';
import { FoodItem } from '../../../shared/models/catalog.models';
import { RatingSummary } from '../../../shared/models/review.models';
import { PublicReviews } from '../../../shared/components/public-reviews/public-reviews';
import { InrPipe } from '../../../shared/pipes/money.pipes';
import { ImageFallback, UsableImagePipe } from '../../../shared/images/broken-images';

export interface FoodDetailData {
  item: Pick<
    FoodItem,
    | 'name'
    | 'description'
    | 'pricePaise'
    | 'isVeg'
    | 'isAvailable'
    | 'imageUrl'
    | 'prepTimeMinutes'
    | 'tags'
  > & {
    category: { name: string; icon: string } | null;
    /** With an id the dialog also shows the dish's reviews. */
    id?: string;
    rating?: RatingSummary;
  };
  restaurant: { name: string; slug: string; isOpenNow?: boolean };
  showRestaurantLink?: boolean;
}

@Component({
  selector: 'bb-food-detail-dialog',
  imports: [
    RouterLink,
    MatDialogModule,
    MatButtonModule,
    IconComponent,
    NpIconPipe,
    VegBadge,
    InrPipe,
    ImageFallback,
    UsableImagePipe,
    PublicReviews,
  ],
  templateUrl: './food-detail-dialog.html',
  styleUrl: './food-detail-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodDetailDialog {
  protected readonly data = inject<FoodDetailData>(MAT_DIALOG_DATA);
}
