import { describe, it, expect } from 'vitest';
import { toUtc, dayKey, dayBounds, isValidTimezone } from '@/lib/time';

describe('time', () => {
  it('converts local wall clock to UTC', () => {
    expect(toUtc('2026-10-10T18:00', 'Australia/Melbourne').toISOString()).toBe('2026-10-10T07:00:00.000Z');
  });
  it('rejects impossible dates', () => {
    expect(() => toUtc('2026-02-30T10:00', 'UTC')).toThrow();
  });
  it('dayKey uses the calendar timezone', () => {
    expect(dayKey(new Date('2026-10-10T20:00:00Z'), 'Australia/Melbourne')).toBe('2026-10-11');
  });
  it('dayBounds spans 23h on DST start day', () => {
    const { start, end } = dayBounds('2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
  });
  it('validates timezones', () => {
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('UTC')).toBe(true);
  });
});
