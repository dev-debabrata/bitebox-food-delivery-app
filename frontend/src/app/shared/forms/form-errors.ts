import { FieldTree, TreeValidationResult, ValidationError } from '@angular/forms/signals';
import { ApiFieldError } from '../models/api.models';

/** Anything we can read errors from: a field tree (call it to get its state). */
export type AnyField = () => { errors: () => readonly ValidationError[]; touched: () => boolean };

/** First error message of a field, for <mat-error>. Material decides when to show it. */
export function firstError(field: AnyField): string {
  return field().errors()[0]?.message ?? '';
}

/**
 * First error message once the user has visited the field (or tried to
 * submit), for NexPrime inputs: `<np-text-input [error]="shownError(form.x)">`.
 */
export function shownError(field: AnyField): string {
  const state = field();
  return state.touched() ? (state.errors()[0]?.message ?? '') : '';
}

/**
 * Turns the API's 422 field errors (e.g. `{ field: 'address.city' }`) into
 * Signal Forms errors attached to the matching fields, so they appear under
 * the right input. Unknown fields are ignored (the form shows a summary).
 * Return the result from a `submit()` action.
 */
export function serverErrors(form: FieldTree<unknown>, details: ApiFieldError[]): TreeValidationResult {
  const errors: ValidationError.WithFieldTree[] = [];
  for (const { field, message } of details) {
    let node: unknown = form;
    for (const key of field.split('.')) node = (node as Record<string, unknown> | undefined)?.[key];
    if (typeof node === 'function') {
      errors.push({ kind: 'server', message, fieldTree: node as FieldTree<unknown> });
    }
  }
  return errors.length ? errors : undefined;
}
