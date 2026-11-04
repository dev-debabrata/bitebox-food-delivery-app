import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormRoot, TreeValidationResult, form, maxLength, validate } from '@angular/forms/signals';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { Observable, filter, firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { ReviewService } from '../../../core/services/review.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { PhotoUpload } from '../../../shared/components/photo-upload/photo-upload';
import { Stars } from '../../../shared/components/stars/stars';
import { serverErrors } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import {
  MyReview,
  OrderRatingInput,
  OrderReviewState,
  RATING_WORDS,
  REVIEW_LIMITS,
  isEditable,
} from '../../../shared/models/review.models';

export interface RateOrderData {
  state: OrderReviewState;
  orderNumber: string;
  riderName: string | null;
}

/** One star row of the dialog. `kind: 'allFood'` rates every unrated dish at once. */
interface Row {
  key: string;
  kind: 'restaurant' | 'allFood' | 'dish' | 'rider';
  title: string;
  hint: string;
  foodItemId?: string;
  review: MyReview | null;
  /** Why the row can't be changed (moderated, or past the edit window). */
  locked: string | null;
}

/** Which field of the one-request batch a new rating of this row goes into. */
const BATCH_FIELD: Partial<Record<Row['kind'], 'restaurant' | 'food' | 'rider'>> = {
  restaurant: 'restaurant',
  allFood: 'food',
  rider: 'rider',
};

/**
 * "Rate your experience" for one order, for rating and later for editing: restaurant, food and
 * delivery stars, the written review and photos, all in one dialog. New ratings are saved in one
 * request; changed ones are updated; each existing rating can also be deleted here.
 */
@Component({
  selector: 'bb-rate-order-dialog',
  imports: [
    DatePipe,
    FormRoot,
    NP_FORM_FIELDS,
    MatDialogModule,
    MatButtonModule,
    IconComponent,
    PhotoUpload,
    Stars,
  ],
  templateUrl: './rate-order-dialog.html',
  styleUrl: './rate-order-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RateOrderDialog {
  protected readonly data = inject<RateOrderData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<RateOrderDialog, OrderReviewState>);
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);

  protected readonly words = [...RATING_WORDS];
  protected readonly limits = REVIEW_LIMITS;
  protected readonly error = signal<string | null>(null);
  protected readonly state = signal(this.data.state);
  protected readonly rows = signal<Row[]>([]);
  /** Something was saved or deleted, so the order page must reload even on "Cancel". */
  private changed = false;

  protected readonly restaurantReview = computed(() => this.state().restaurant.review);
  /** The words and photos belong to the restaurant review. */
  protected readonly wordsLocked = computed(() => {
    const r = this.restaurantReview();
    return !!r && !isEditable(r);
  });
  protected readonly editing = computed(() => this.rows().some((r) => r.review));
  protected readonly canSave = computed(
    () => this.state().canReview && this.rows().some((r) => !r.locked),
  );

  protected readonly model = signal({ ratings: [] as number[], comment: '' });
  protected readonly photos = signal<string[]>([]);
  protected readonly form = form(
    this.model,
    (path) => {
      maxLength(path.comment, REVIEW_LIMITS.comment, {
        message: `Keep it under ${REVIEW_LIMITS.comment} characters`,
      });
      validate(path.comment, ({ value, valueOf }) =>
        value().trim() && !valueOf(path.ratings)[0]
          ? { kind: 'needsRestaurant', message: 'Rate the restaurant to post a written review' }
          : undefined,
      );
    },
    { submission: { action: () => this.save() } },
  );

  constructor() {
    this.build(this.data.state);
  }

  private build(s: OrderReviewState): void {
    const lock = (r: MyReview | null): string | null => {
      if (!r) return s.canReview ? null : (s.reason ?? 'Reviews are closed for this order');
      if (r.status !== 'published')
        return `${r.status === 'hidden' ? 'Hidden' : 'Removed'} by moderators: ${r.moderation?.reason ?? ''}`;
      return isEditable(r) ? null : 'The edit window has closed';
    };
    const rows: Row[] = [
      {
        key: 'restaurant',
        kind: 'restaurant',
        title: 'Restaurant',
        hint: `${s.restaurant.name} experience`,
        review: s.restaurant.review,
        locked: lock(s.restaurant.review),
      },
    ];
    // No dish rated yet: one "Food quality" row for all of them (as when rating the first time).
    if (s.items.every((i) => !i.review)) {
      rows.push({
        key: 'food',
        kind: 'allFood',
        title: 'Food quality',
        hint: `Taste, quality and packaging · ${s.items.map((i) => i.name).join(', ')}`,
        review: null,
        locked: lock(null),
      });
    } else {
      for (const i of s.items)
        rows.push({
          key: i.foodItem,
          kind: 'dish',
          title: i.name,
          hint: 'Taste, quality and packaging',
          foodItemId: i.foodItem,
          review: i.review,
          locked: lock(i.review),
        });
    }
    if (s.rider)
      rows.push({
        key: 'rider',
        kind: 'rider',
        title: 'Delivery partner',
        hint: `Delivery experience${this.data.riderName ? ' with ' + this.data.riderName : ''}`,
        review: s.rider.review,
        locked: lock(s.rider.review),
      });
    this.rows.set(rows);
    this.model.set({
      ratings: rows.map((r) => r.review?.rating ?? 0),
      comment: s.restaurant.review?.comment ?? '',
    });
    this.photos.set([...(s.restaurant.review?.images ?? [])]);
  }

  private async save(): Promise<TreeValidationResult> {
    const rows = this.rows();
    const { ratings, comment } = this.model();
    const photos = this.photos();
    const orderId = this.state().orderId;
    this.error.set(null);

    // New ratings in one all-or-nothing request (restaurant, all dishes, rider).
    const batch: OrderRatingInput = {};
    const dishCreates: { foodItemId: string; rating: number }[] = [];
    const updates: { review: MyReview; input: { rating?: number; comment?: string; images?: string[] } }[] = [];
    rows.forEach((row, i) => {
      const rating = ratings[i];
      if (row.locked) return;
      if (!row.review) {
        if (!rating) return;
        const field = BATCH_FIELD[row.kind];
        if (field) batch[field] = rating;
        else dishCreates.push({ foodItemId: row.foodItemId!, rating });
        return;
      }
      const input: { rating?: number; comment?: string; images?: string[] } = {};
      if (rating && rating !== row.review.rating) input.rating = rating;
      if (row.kind === 'restaurant') {
        if (comment.trim() !== row.review.comment) input.comment = comment.trim();
        if (photos.join() !== row.review.images.join()) input.images = photos;
      }
      if (Object.keys(input).length) updates.push({ review: row.review, input });
    });
    if (batch.restaurant) {
      if (comment.trim()) batch.comment = comment.trim();
      if (photos.length) batch.images = photos;
    }
    if (!Object.keys(batch).length && !dishCreates.length && !updates.length) {
      this.error.set(this.editing() ? 'Nothing has changed.' : 'Choose stars for at least one of them.');
      return undefined;
    }

    try {
      // The batch, each new dish rating and each edit touch different reviews: send them together.
      const [state] = await Promise.all([
        Object.keys(batch).length
          ? firstValueFrom(this.reviews.rateOrder(orderId, batch))
          : Promise.resolve(null),
        Promise.all([
          ...dishCreates.map((d) =>
            firstValueFrom(this.reviews.create({ orderId, target: 'food', ...d })),
          ),
          ...updates.map((u) => firstValueFrom(this.reviews.update(u.review.id, u.input))),
        ]),
      ]);
      // The batch answers with the new state; anything else needs a fresh read.
      const onlyBatch = !dishCreates.length && !updates.length;
      this.ref.close(onlyBatch && state ? state : await firstValueFrom(this.reviews.forOrder(orderId)));
      return undefined;
    } catch (err) {
      this.changed = true; // earlier steps of this save may have gone through
      this.error.set(errorMessage(err, 'Could not save your rating.'));
      this.reload();
      return serverErrors(this.form, fieldErrors(err));
    }
  }

  protected remove(row: Row): void {
    const review = row.review;
    if (!review) return;
    confirmed(this.dialog, {
      title: 'Delete this rating?',
      message: `Your rating of ${row.kind === 'restaurant' ? 'the restaurant (with its review and photos)' : row.title} will be removed. You can't rate it again for this order.`,
      confirmLabel: 'Delete',
      danger: true,
    }).subscribe(() =>
      this.reviews.remove(review.id).subscribe({
        next: () => {
          this.changed = true;
          this.reload();
        },
        error: (err: unknown) => this.error.set(errorMessage(err)),
      }),
    );
  }

  protected close(): void {
    if (this.changed) this.ref.close(this.state());
    else this.ref.close();
  }

  private reload(): void {
    this.reviews.forOrder(this.state().orderId).subscribe((s) => {
      this.state.set(s);
      this.build(s);
    });
  }
}

/** Emits the updated review state when something was saved or deleted. */
export function openRateOrder(dialog: MatDialog, data: RateOrderData): Observable<OrderReviewState> {
  return dialog
    .open<RateOrderDialog, RateOrderData, OrderReviewState>(RateOrderDialog, {
      data,
      width: '560px',
      maxWidth: '95vw',
      autoFocus: 'first-tabbable',
    })
    .afterClosed()
    .pipe(filter((s): s is OrderReviewState => !!s));
}
