import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AnyField, shownError } from '../form-errors';

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
