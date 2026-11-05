import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { DatePipe } from '@angular/common';
import { IconComponent } from 'nexprime';
import { RATING_WORDS, ReviewResponse } from '../../models/review.models';
import { Stars } from '../stars/stars';
import { ReviewReply } from '../review-reply/review-reply';
import { openPhotoViewer } from '../photo-viewer/photo-viewer';

export interface ReviewCardData {
  rating: number;
  comment: string;
  authorName: string;
  createdAt: string;
  editedAt: string | null;
  foodName?: string | null;
  images?: string[];
  response?: ReviewResponse | null;
  verifiedOrder?: boolean;
}

/** One review: stars, words, author and date, and the restaurant's reply. Actions are projected. */
@Component({
  selector: 'bb-review-card',
  imports: [DatePipe, IconComponent, Stars, ReviewReply],
  templateUrl: './review-card.html',
  styleUrl: './review-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewCard {
  readonly review = input.required<ReviewCardData>();
  readonly showFood = input(false);
  readonly responder = input('The restaurant');

  protected readonly words = RATING_WORDS;
  private readonly dialog = inject(MatDialog);

  protected view(index: number): void {
    const r = this.review();
    openPhotoViewer(this.dialog, { images: r.images ?? [], index, caption: r.authorName });
  }
}
