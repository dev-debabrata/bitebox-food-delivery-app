import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TimePickerComponent, ToggleComponent } from 'nexprime';
import { WEEK_DAYS, WeekDay, WeeklyHours } from '../../../../shared/models/catalog.models';
import { dateToTime, timeToDate } from '../../../../shared/forms/time-of-day';

const NAMES: Record<WeekDay, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/**
 * Different hours for each day (one slot a day; closing after midnight is allowed). Off: the
 * daily opening and closing times apply every day.
 */
@Component({
  selector: 'bb-weekly-hours',
  imports: [ToggleComponent, TimePickerComponent],
  templateUrl: './weekly-hours.html',
  styleUrl: './weekly-hours.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WeeklyHoursEditor {
  readonly hours = model<WeeklyHours | null>(null);
  /** The daily hours, used to fill each day when this is switched on. */
  readonly daily = input<{ open: string; close: string }>({ open: '10:00', close: '23:00' });

  protected readonly days = WEEK_DAYS;
  protected readonly names = NAMES;
  protected readonly toDate = timeToDate;

  protected enable(on: boolean): void {
    const slot = this.daily();
    this.hours.set(
      on ? (Object.fromEntries(WEEK_DAYS.map((d) => [d, [{ ...slot }]])) as WeeklyHours) : null,
    );
  }

  protected setOpen(day: WeekDay, open: boolean): void {
    this.patch(day, open ? [{ ...this.daily() }] : []);
  }

  protected setTime(day: WeekDay, part: 'open' | 'close', value: Date | null): void {
    const slot = this.hours()?.[day]?.[0];
    if (slot && value) this.patch(day, [{ ...slot, [part]: dateToTime(value) }]);
  }

  private patch(day: WeekDay, slots: { open: string; close: string }[]): void {
    this.hours.update((h) => (h ? { ...h, [day]: slots } : h));
  }
}
