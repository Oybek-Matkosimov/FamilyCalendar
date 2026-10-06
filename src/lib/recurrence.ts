import { rrulestr, type RRule } from 'rrule';
import { DateTime } from 'luxon';
import type { RecurrenceInput } from './validation';
import type { Occurrence } from './conflicts';

export function buildRRule(r: RecurrenceInput): string {
  const parts: string[] = [];
  switch (r.freq) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekdays':
      parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
      break;
    case 'weekly':
    case 'custom':
      parts.push('FREQ=WEEKLY');
      if (r.byDay?.length) parts.push('BYDAY=' + r.byDay.join(','));
      break;
    case 'monthly':
      parts.push('FREQ=MONTHLY');
      break;
  }
  if (r.interval && r.interval > 1 && r.freq !== 'weekdays') parts.splice(1, 0, `INTERVAL=${r.interval}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replaceAll('-', '')}T235959Z`);
  return parts.join(';');
}

export interface SeriesSource {
  id: string;
  memberId: string;
  title: string;
  allDay: boolean;
  tz: string;
  /** Wall-clock start/end of the FIRST occurrence, 'YYYY-MM-DDTHH:mm' */
  localStart: string;
  localEnd: string;
  rrule: string;
  /** Local dates (YYYY-MM-DD) of skipped occurrences */
  exceptions: string[];
  recurUntil: Date | null;
}

/**
 * Occurrences are generated in "floating" UTC (wall-clock fields stored as UTC) and each wall-clock is then
 * resolved in the series tz, so DST changes never shift the local time of day.
 */
export function expandSeries(s: SeriesSource, from: Date, to: Date, limit = 2000): Occurrence[] {
  const startFloating = DateTime.fromISO(s.localStart, { zone: 'utc' });
  const durationMs =
    DateTime.fromISO(s.localEnd, { zone: s.tz }).toMillis() - DateTime.fromISO(s.localStart, { zone: s.tz }).toMillis();
  const rule = rrulestr(`DTSTART:${startFloating.toFormat("yyyyMMdd'T'HHmmss'Z'")}\nRRULE:${s.rrule}`) as RRule;

  // Widen the window so occurrences that start before `from` but end inside it are found.
  const widenDays = Math.ceil(durationMs / 86400000) + 1;
  const winFrom = DateTime.fromJSDate(from, { zone: s.tz }).minus({ days: widenDays }).setZone('utc', { keepLocalTime: true }).toJSDate();
  const winTo = DateTime.fromJSDate(to, { zone: s.tz }).plus({ days: 1 }).setZone('utc', { keepLocalTime: true }).toJSDate();

  const out: Occurrence[] = [];
  for (const d of rule.between(winFrom, winTo, true)) {
    const wall = DateTime.fromJSDate(d, { zone: 'utc' });
    const date = wall.toFormat('yyyy-MM-dd');
    if (s.exceptions.includes(date)) continue;
    const start = DateTime.fromObject(
      { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute },
      { zone: s.tz },
    ).toJSDate();
    if (s.recurUntil && start > s.recurUntil) continue;
    const end = new Date(start.getTime() + durationMs);
    if (end <= from || start >= to) continue;
    out.push({ eventId: s.id, memberId: s.memberId, title: s.title, start, end, allDay: s.allDay, occurrenceDate: date });
    if (out.length >= limit) break;
  }
  return out;
}
