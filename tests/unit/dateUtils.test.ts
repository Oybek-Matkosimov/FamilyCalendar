import { describe, it, expect } from 'vitest';
import { monthGrid, weekDays, rangeFor, shift, today, addDays, fmtTime, fmtRange, fmtDayLong, minutesFromDayStart } from '@/lib/client/dateUtils';

describe('monthGrid', () => {
  const grid = monthGrid('2026-10-15', 'UTC');
  it('is 6 rows of 7 days starting on a Monday', () => {
    expect(grid).toHaveLength(6);
    expect(grid.every((r) => r.length === 7)).toBe(true);
    expect(grid[0]![0]).toBe('2026-09-28');
  });
  it('contains the whole month in order', () => {
    const flat = grid.flat();
    expect(flat).toContain('2026-10-01');
    expect(flat).toContain('2026-10-31');
    expect([...flat].sort()).toEqual(flat);
  });
});

describe('weekDays / rangeFor / shift', () => {
  it('week starts on Monday', () => {
    expect(weekDays('2026-10-15', 'UTC')[0]).toBe('2026-10-12');
    expect(weekDays('2026-10-15', 'UTC')).toHaveLength(7);
    expect(weekDays('2026-10-18', 'UTC')[0]).toBe('2026-10-12'); // Sunday belongs to the Monday before
  });
  it('rangeFor month covers the whole grid; week 7 days; day 1 day', () => {
    const m = rangeFor('month', '2026-10-15', 'UTC');
    expect(m.from.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect((m.to.getTime() - m.from.getTime()) / 86400000).toBe(42);
    const w = rangeFor('week', '2026-10-15', 'UTC');
    expect((w.to.getTime() - w.from.getTime()) / 86400000).toBe(7);
    const d = rangeFor('day', '2026-10-15', 'UTC');
    expect(d.from.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(d.to.toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });
  it('shift moves by the view unit and clamps month ends', () => {
    expect(shift('month', '2026-10-15', 1)).toBe('2026-11-15');
    expect(shift('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(shift('week', '2026-10-15', -1)).toBe('2026-10-08');
    expect(shift('day', '2026-10-15', 1)).toBe('2026-10-16');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
  it('today is formatted as YYYY-MM-DD in the calendar timezone', () => {
    expect(today('Australia/Melbourne')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatting', () => {
  it('formats times and ranges in the calendar timezone', () => {
    expect(fmtTime('2026-10-10T07:00:00.000Z', 'Australia/Melbourne')).toBe('6:00 PM');
    expect(fmtRange('2026-10-10T07:00:00.000Z', '2026-10-10T08:30:00.000Z', 'Australia/Melbourne', false)).toBe('6:00 PM – 7:30 PM');
    expect(fmtRange('2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'UTC', true)).toBe('All day');
    expect(fmtDayLong('2026-10-10')).toBe('Saturday, October 10');
  });
  it('minutesFromDayStart handles the local day', () => {
    expect(minutesFromDayStart('2026-10-10T07:00:00.000Z', '2026-10-10', 'Australia/Melbourne')).toBe(18 * 60);
    expect(minutesFromDayStart('2026-10-09T00:00:00.000Z', '2026-10-10', 'UTC')).toBe(0); // clamped to the day
    expect(minutesFromDayStart('2026-10-12T00:00:00.000Z', '2026-10-10', 'UTC')).toBe(24 * 60);
  });
});
