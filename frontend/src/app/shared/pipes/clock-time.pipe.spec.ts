import { formatClockTime } from './clock-time.pipe';

describe('formatClockTime', () => {
  it('converts 24-hour times to 12-hour times with AM/PM', () => {
    expect(formatClockTime('10:00')).toBe('10:00 AM');
    expect(formatClockTime('23:00')).toBe('11:00 PM');
    expect(formatClockTime('09:30')).toBe('9:30 AM');
  });

  it('handles midnight and noon', () => {
    expect(formatClockTime('00:00')).toBe('12:00 AM');
    expect(formatClockTime('12:15')).toBe('12:15 PM');
  });

  it('leaves missing or unexpected values alone', () => {
    expect(formatClockTime(undefined)).toBe('');
    expect(formatClockTime('late')).toBe('late');
    expect(formatClockTime('25:00')).toBe('25:00');
  });
});
