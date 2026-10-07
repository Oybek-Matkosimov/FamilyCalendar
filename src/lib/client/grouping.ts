import { daysSpanned } from '@/lib/conflicts';
import type { ConflictDTO, OccurrenceDTO } from './types';

/** Occurrences keyed by every local day they touch (events crossing midnight appear on both days). */
export function occurrencesByDay(occs: OccurrenceDTO[], tz: string): Map<string, OccurrenceDTO[]> {
  const map = new Map<string, OccurrenceDTO[]>();
  for (const o of occs) {
    for (const day of daysSpanned(new Date(o.start), new Date(o.end), tz)) {
      const list = map.get(day);
      if (list) list.push(o);
      else map.set(day, [o]);
    }
  }
  return map;
}

/** Is this occurrence part of a conflict on `day`? */
export function inConflictOn(ev: OccurrenceDTO, day: string, conflicts: ConflictDTO[]): boolean {
  return conflicts.some((c) => c.days.includes(day) && c.occurrences.some((o) => o.eventId === ev.eventId && o.start === ev.start));
}

export function conflictsOnDay(day: string, conflicts: ConflictDTO[]): ConflictDTO[] {
  return conflicts.filter((c) => c.days.includes(day));
}
