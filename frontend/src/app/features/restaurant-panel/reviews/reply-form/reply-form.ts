import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormRoot, TreeValidationResult, form, maxLength, minLength, required } from '@angular/forms/signals';
import { ButtonComponent, IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { ReviewService } from '../../../../core/services/review.service';
import { serverErrors } from '../../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { REVIEW_LIMITS, RestaurantReview } from '../../../../shared/models/review.models';


/** Inline public reply to one review. The review itself is never changed. */
@Component({
  selector: 'bb-reply-form',
  imports: [FormRoot, NP_FORM_FIELDS, ButtonComponent, IconComponent],
  templateUrl: './reply-form.html',
  styleUrl: './reply-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReplyForm implements OnInit {
  private readonly reviews = inject(ReviewService);

  readonly review = input.required<RestaurantReview>();
  readonly saved = output<RestaurantReview>();
  readonly cancelled = output<void>();

  protected readonly error = signal<string | null>(null);
  protected readonly model = signal({ text: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      required(path.text, { message: 'Write a reply' });
      minLength(path.text, 2, { message: 'Write a reply' });
      maxLength(path.text, REVIEW_LIMITS.reply, {
        message: `Keep it under ${REVIEW_LIMITS.reply} characters`,
      });
    },
    { submission: { action: () => this.send() } },
  );

  ngOnInit(): void {
    this.model.set({ text: this.review().response?.text ?? '' });
  }

  private async send(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      this.saved.emit(
        await firstValueFrom(this.reviews.respond(this.review().id, this.model().text.trim())),
      );
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not post the reply.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
