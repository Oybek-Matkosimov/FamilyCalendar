import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { occurrenceKey, type ConflictGroup, type Occurrence } from '@/lib/conflicts';

export interface MemberName {
  name: string;
  removed: boolean;
}

export interface ConflictDTO {
  id: string;
  start: string;
  end: string;
  days: string[];
  members: { id: string; name: string }[];
  occurrences: { eventId: string; title: string; memberId: string; memberName: string; start: string; end: string }[];
  overlaps: { aEventId: string; bEventId: string; start: string; end: string; sameMember: boolean; summary: string }[];
}

function fmtRange(start: Date, end: Date, tz: string): string {
  const s = DateTime.fromJSDate(start, { zone: tz }).setLocale('en-US');
  const e = DateTime.fromJSDate(end, { zone: tz }).setLocale('en-US');
  const sameDay = s.toFormat('yyyy-MM-dd') === e.toFormat('yyyy-MM-dd');
  const fmt = (d: DateTime) => (sameDay ? d.toFormat('h:mm a') : d.toFormat('MMM d, h:mm a'));
  return `from ${fmt(s)} to ${fmt(e)}`;
}

/** Human-readable conflict descriptions, e.g. "Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM." */
export function buildConflictDTOs(groups: ConflictGroup[], names: Map<string, MemberName>, tz: string): ConflictDTO[] {
  const nameOf = (id: string) => names.get(id)?.name ?? 'Unknown';
  return groups.map((g) => {
    const members = new Map<string, string>();
    for (const o of g.occurrences) members.set(o.memberId, nameOf(o.memberId));
    const id = createHash('sha1').update(g.occurrences.map(occurrenceKey).sort().join('|')).digest('hex').slice(0, 16);
    return {
      id,
      start: g.start.toISOString(),
      end: g.end.toISOString(),
      days: g.days,
      members: [...members].map(([mid, name]) => ({ id: mid, name })),
      occurrences: g.occurrences
        .slice()
        .sort((x: Occurrence, y: Occurrence) => x.start.getTime() - y.start.getTime())
        .map((o) => ({
          eventId: o.eventId, title: o.title, memberId: o.memberId, memberName: nameOf(o.memberId),
          start: o.start.toISOString(), end: o.end.toISOString(),
        })),
      overlaps: g.overlaps.map((ov) => ({
        aEventId: ov.a.eventId,
        bEventId: ov.b.eventId,
        start: ov.start.toISOString(),
        end: ov.end.toISOString(),
        sameMember: ov.sameMember,
        summary: ov.sameMember
          ? `${nameOf(ov.a.memberId)} is double-booked ${fmtRange(ov.start, ov.end, tz)}.`
          : `${nameOf(ov.a.memberId)} and ${nameOf(ov.b.memberId)} have overlapping schedules ${fmtRange(ov.start, ov.end, tz)}.`,
      })),
    };
  });
}
