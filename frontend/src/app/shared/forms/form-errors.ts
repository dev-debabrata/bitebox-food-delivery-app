import { FieldTree, TreeValidationResult, ValidationError } from '@angular/forms/signals';
import { ApiFieldError } from '../models/api.models';

export type AnyField = () => { errors: () => readonly ValidationError[]; touched: () => boolean };

export function shownError(field: AnyField): string {
  const state = field();
  return state.touched() ? (state.errors()[0]?.message ?? '') : '';
}

export function serverErrors(
  form: FieldTree<unknown>,
  details: ApiFieldError[],
): TreeValidationResult {
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
