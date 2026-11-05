import { signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { Observable } from 'rxjs';
import { resourceError, resourceValue } from '../../core/services/api-error';

export const PERIOD_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function periodReport<T>(load: (days: number) => Observable<T>, errorText: string) {
  const model = signal({ days: '30' });
  const resource = rxResource({
    params: () => Number(model().days),
    stream: ({ params }) => load(params),
  });
  return {
    periods: PERIOD_OPTIONS,
    filters: form(model),
    resource,
    data: resourceValue(resource),
    error: resourceError(resource, errorText),
  };
}
