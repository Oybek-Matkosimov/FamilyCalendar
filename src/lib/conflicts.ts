import { DateTime } from 'luxon';

export interface Occurrence {
  eventId: string;
  memberId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Local (calendar tz) date the occurrence starts on, YYYY-MM-DD */
  occurrenceDate: string;
}

export interface Overlap {
  a: Occurrence;
  b: Occurrence;
  start: Date;
  end: Date;
  sameMember: boolean;
}

export interface ConflictGroup {
  occurrences: Occurrence[];
  overlaps: Overlap[];
  start: Date;
  end: Date;
  days: string[];
}

/** Half-open [start, end) pairwise overlaps of timed occurrences. All-day occurrences never conflict. */
export function findOverlaps(all: Occurrence[]): Overlap[] {
  const timed = all
    .filter((o) => !o.allDay)
    .sort((x, y) => x.start.getTime() - y.start.getTime() || x.eventId.localeCompare(y.eventId));
  const out: Overlap[] = [];
  let active: Occurrence[] = [];
  for (const cur of timed) {
    active = active.filter((a) => a.end.getTime() > cur.start.getTime());
    for (const a of active) {
      const start = new Date(Math.max(a.start.getTime(), cur.start.getTime()));
      const end = new Date(Math.min(a.end.getTime(), cur.end.getTime()));
      if (end > start) out.push({ a, b: cur, start, end, sameMember: a.memberId === cur.memberId });
    }
    active.push(cur);
  }
  return out;
}

export const occurrenceKey = (o: Occurrence): string => `${o.eventId}@${o.occurrenceDate}`;

/** Connected components of the overlap graph. */
export function groupConflicts(overlaps: Overlap[], tz: string): ConflictGroup[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const byKey = new Map<string, Occurrence>();
  for (const ov of overlaps) {
    for (const o of [ov.a, ov.b]) {
      byKey.set(occurrenceKey(o), o);
      if (!parent.has(occurrenceKey(o))) parent.set(occurrenceKey(o), occurrenceKey(o));
    }
  }
  for (const ov of overlaps) parent.set(find(occurrenceKey(ov.a)), find(occurrenceKey(ov.b)));

  const groups = new Map<string, ConflictGroup>();
  for (const [k, o] of byKey) {
    const r = find(k);
    const g = groups.get(r) ?? { occurrences: [], overlaps: [], start: o.start, end: o.end, days: [] };
    g.occurrences.push(o);
    if (o.start < g.start) g.start = o.start;
    if (o.end > g.end) g.end = o.end;
    groups.set(r, g);
  }
  for (const ov of overlaps) groups.get(find(occurrenceKey(ov.a)))!.overlaps.push(ov);

  return [...groups.values()]
    .map((g) => {
      const days = new Set<string>();
      for (const ov of g.overlaps) for (const d of daysSpanned(ov.start, ov.end, tz)) days.add(d);
      return { ...g, days: [...days].sort() };
    })
    .sort((x, y) => x.start.getTime() - y.start.getTime());
}

export function daysSpanned(start: Date, end: Date, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromJSDate(start, { zone: tz }).startOf('day');
  const last = DateTime.fromJSDate(new Date(end.getTime() - 1), { zone: tz }).startOf('day');
  while (d <= last) {
    out.push(d.toFormat('yyyy-MM-dd'));
    d = d.plus({ days: 1 });
  }
  return out;
}

export function dayStatuses(occ: Occurrence[], groups: ConflictGroup[], tz: string): Record<string, 'scheduled' | 'conflict'> {
  const res: Record<string, 'scheduled' | 'conflict'> = {};
  for (const o of occ) for (const d of daysSpanned(o.start, o.end, tz)) res[d] = 'scheduled';
  for (const g of groups) for (const d of g.days) res[d] = 'conflict';
  return res;
}
