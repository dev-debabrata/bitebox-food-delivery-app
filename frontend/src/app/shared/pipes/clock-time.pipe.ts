import { Pipe, PipeTransform } from '@angular/core';

/** "23:00" (the API's 24-hour HH:mm) → "11:00 PM". Anything else is shown as it is. */
export function formatClockTime(value: string | null | undefined): string {
  const [, h, m] = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value ?? '') ?? [];
  return h ? `${+h % 12 || 12}:${m} ${+h < 12 ? 'AM' : 'PM'}` : (value ?? '');
}

@Pipe({ name: 'clockTime' })
export class ClockTimePipe implements PipeTransform {
  transform = formatClockTime;
}
