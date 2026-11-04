import { Directive, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';

@Directive({
  selector:
    'np-text-input[formField], np-textarea[formField], np-input-number[formField], np-select[formField], np-calendar[formField], np-time-picker[formField], np-rating[formField]',
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class NpFieldTouch {
  private readonly formField = inject(FormField);
  private readonly host = this.formField.element;

  protected onFocusOut(event: FocusEvent): void {
    if (event.relatedTarget instanceof Node && this.host.contains(event.relatedTarget)) return;
    this.formField.state().markAsTouched();
  }
}
