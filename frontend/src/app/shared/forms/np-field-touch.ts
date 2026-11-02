import { Directive, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';

/**
 * NexPrime inputs have no `touch` output, so Signal Forms never learns the
 * user left them. Mark the bound field touched when focus leaves the control,
 * so its error shows after the first visit (like a native input) instead of
 * only after submit.
 */
@Directive({
  selector:
    'np-text-input[formField], np-textarea[formField], np-input-number[formField], np-select[formField], np-calendar[formField], np-time-picker[formField]',
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class NpFieldTouch {
  private readonly formField = inject(FormField);
  private readonly host = this.formField.element;

  protected onFocusOut(event: FocusEvent): void {
    // Moving between parts of the same control (e.g. a select's panel) is not leaving it.
    if (event.relatedTarget instanceof Node && this.host.contains(event.relatedTarget)) return;
    this.formField.state().markAsTouched();
  }
}
