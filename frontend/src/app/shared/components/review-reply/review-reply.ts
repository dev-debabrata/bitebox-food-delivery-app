import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from 'nexprime';
import { ReviewResponse } from '../../models/review.models';

/**
 * A restaurant's public reply under a review: "<responder> replied [to <about>] · date" and the text.
 * Used everywhere a reply shows (customer order page, restaurant page, restaurant and admin panels).
 */
@Component({
  selector: 'bb-review-reply',
  imports: [DatePipe, IconComponent],
  templateUrl: './review-reply.html',
  styleUrl: './review-reply.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewReply {
  /** Admin views send the stored reply as is, so every field is optional. */
  readonly reply = input.required<Partial<ReviewResponse>>();
  readonly responder = input('The restaurant');
  /** What was replied to, e.g. "your review" or a dish name. */
  readonly about = input<string>();
}
