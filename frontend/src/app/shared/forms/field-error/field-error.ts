import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AnyField, shownError } from '../form-errors';

/**
 * Error line under NexPrime controls that have no `error` input of their own
 * (textarea, number, select, date, time). Shows once the field is touched.
 *
 *   <np-textarea [formField]="form.note" label="Note" />
 *   <bb-field-error [field]="form.note" />
 */
@Component({
  selector: 'bb-field-error',
  templateUrl: './field-error.html',
  styleUrl: './field-error.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FieldError {
  readonly field = input.required<AnyField>();
  protected readonly message = computed(() => shownError(this.field()));
}
