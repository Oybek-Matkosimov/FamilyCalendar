import { DateTime } from 'luxon';

export type View = 'month' | 'week' | 'day';

const dt = (day: string, tz: string) => DateTime.fromISO(day, { zone: tz });
const key = (d: DateTime) => d.toFormat('yyyy-MM-dd');

export const today = (tz: string): string => key(DateTime.now().setZone(tz));

export function addDays(day: string, n: number): string {
  return key(DateTime.fromISO(day, { zone: 'utc' }).plus({ days: n }));
}

/** 6 weeks x 7 days (Monday first) covering the month that contains `anchor`. */
export function monthGrid(anchor: string, tz: string): string[][] {
  const first = dt(anchor, tz).startOf('month').startOf('week');
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => key(first.plus({ days: w * 7 + d }))));
}

export function weekDays(anchor: string, tz: string): string[] {
  const first = dt(anchor, tz).startOf('week');
  return Array.from({ length: 7 }, (_, d) => key(first.plus({ days: d })));
}

/** [from, to) instants covering everything the view displays. */
export function rangeFor(view: View, anchor: string, tz: string): { from: Date; to: Date } {
  let first: DateTime;
  let days: number;
  if (view === 'month') {
    first = dt(anchor, tz).startOf('month').startOf('week');
    days = 42;
  } else if (view === 'week') {
    first = dt(anchor, tz).startOf('week');
    days = 7;
  } else {
    first = dt(anchor, tz).startOf('day');
    days = 1;
  }
  return { from: first.toUTC().toJSDate(), to: first.plus({ days }).startOf('day').toUTC().toJSDate() };
}

export function shift(view: View, anchor: string, dir: -1 | 1): string {
  const d = DateTime.fromISO(anchor, { zone: 'utc' });
  const next = view === 'month' ? d.plus({ months: dir }) : view === 'week' ? d.plus({ weeks: dir }) : d.plus({ days: dir });
  return key(next);
}

const en = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).setLocale('en-US');

export const fmtTime = (iso: string, tz: string): string => en(iso, tz).toFormat('h:mm a');

export function fmtRange(startIso: string, endIso: string, tz: string, allDay: boolean): string {
  if (allDay) return 'All day';
  return `${fmtTime(startIso, tz)} – ${fmtTime(endIso, tz)}`;
}

export const fmtDayLong = (day: string): string => DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-US').toFormat('EEEE, MMMM d');
export const fmtDayShort = (day: string): string => DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-US').toFormat('EEE, MMM d');
export const fmtMonthTitle = (anchor: string): string => DateTime.fromISO(anchor, { zone: 'utc' }).setLocale('en-US').toFormat('MMMM yyyy');
export const fmtDateTime = (iso: string, tz: string): string => en(iso, tz).toFormat('MMM d, h:mm a');
export const dayNumber = (day: string): string => String(Number(day.slice(8, 10)));

/** Minutes between the start of local `day` and `iso`, clamped to [0, 1440]. */
export function minutesFromDayStart(iso: string, day: string, tz: string): number {
  const start = dt(day, tz).startOf('day');
  const mins = en(iso, tz).diff(start, 'minutes').minutes;
  return Math.max(0, Math.min(24 * 60, Math.round(mins)));
}

/** Local 'YYYY-MM-DD' and 'HH:mm' parts of an instant in the calendar timezone. */
export function localParts(iso: string, tz: string): { date: string; time: string } {
  const d = en(iso, tz);
  return { date: d.toFormat('yyyy-MM-dd'), time: d.toFormat('HH:mm') };
}

export function addMinutesLocal(date: string, time: string, minutes: number): { date: string; time: string } {
  const d = DateTime.fromISO(`${date}T${time}`, { zone: 'utc' }).plus({ minutes });
  return { date: d.toFormat('yyyy-MM-dd'), time: d.toFormat('HH:mm') };
}
