import { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorBody, ApiFieldError } from '../../shared/models/api.models';

/** Human-readable message for any HTTP error. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'Cannot reach BiteBox servers. Check your connection and try again.';
    const body = error.error as Partial<ApiErrorBody> | null;
    if (body && typeof body.message === 'string') return body.message;
  }
  return fallback;
}

/** Field-level validation errors returned with HTTP 422. */
export function fieldErrors(error: unknown): ApiFieldError[] {
  if (error instanceof HttpErrorResponse && error.status === 422) {
    return (error.error as ApiErrorBody | null)?.error?.details ?? [];
  }
  return [];
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof HttpErrorResponse) return (error.error as ApiErrorBody | null)?.error?.code;
  return undefined;
}
