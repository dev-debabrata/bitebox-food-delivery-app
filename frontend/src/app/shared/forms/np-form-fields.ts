import { FormField } from '@angular/forms/signals';
import {
  CalendarComponent,
  InputNumberComponent,
  SearchInputComponent,
  SelectComponent,
  TextInputComponent,
  TextareaComponent,
  TimePickerComponent,
} from 'nexprime';
import { FieldError } from './field-error/field-error';
import { NpFieldTouch } from './np-field-touch';
import { NpInputAttrs } from './np-input-attrs';

/** Everything a form template needs for NexPrime inputs bound with `[formField]`. */
export const NP_FORM_FIELDS = [
  FormField,
  NpFieldTouch,
  NpInputAttrs,
  FieldError,
  TextInputComponent,
  TextareaComponent,
  InputNumberComponent,
  SelectComponent,
  SearchInputComponent,
  CalendarComponent,
  TimePickerComponent,
] as const;
