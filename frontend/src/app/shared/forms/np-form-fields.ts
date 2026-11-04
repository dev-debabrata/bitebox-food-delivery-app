import { FormField } from '@angular/forms/signals';
import {
  CalendarComponent,
  InputNumberComponent,
  RatingComponent,
  SearchInputComponent,
  SelectComponent,
  TextInputComponent,
  TextareaComponent,
  TimePickerComponent,
} from 'nexprime';
import { FieldError } from './field-error/field-error';
import { NpFieldTouch } from './np-field-touch';
import { NpInputAttrs } from './np-input-attrs';

export const NP_FORM_FIELDS = [
  FormField,
  NpFieldTouch,
  NpInputAttrs,
  FieldError,
  TextInputComponent,
  TextareaComponent,
  InputNumberComponent,
  RatingComponent,
  SelectComponent,
  SearchInputComponent,
  CalendarComponent,
  TimePickerComponent,
] as const;
