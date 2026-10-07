import { DateTime } from 'luxon';

/** Dates further than this from today are rejected: nobody plans a family calendar that far out, and unbounded dates let one request make the server expand recurring events for centuries. */
export const SUPPORTED_YEARS = 30;
export const withinSupportedYears = (d: Date): boolean =>
  Number.isFinite(d.getTime()) && Math.abs(d.getTime() - Date.now()) <= SUPPORTED_YEARS * 365.25 * 86400000;

export const isValidTimezone = (tz: string): boolean => DateTime.local().setZone(tz).isValid;

/** Interpret a local wall-clock ISO string ('YYYY-MM-DDTHH:mm') in `tz` and return the UTC instant. */
export function toUtc(local: string, tz: string): Date {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) throw new Error('Invalid date/time');
  return dt.toUTC().toJSDate();
}

export const dayKey = (d: Date, tz: string): string => DateTime.fromJSDate(d, { zone: tz }).toFormat('yyyy-MM-dd');

export function dayBounds(day: string, tz: string): { start: Date; end: Date } {
  const s = DateTime.fromISO(day, { zone: tz }).startOf('day');
  return { start: s.toUTC().toJSDate(), end: s.plus({ days: 1 }).startOf('day').toUTC().toJSDate() };
}
