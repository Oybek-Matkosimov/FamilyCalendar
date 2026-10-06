import { describe, it, expect } from 'vitest';
import { findOverlaps, groupConflicts, dayStatuses, type Occurrence } from '@/lib/conflicts';

const occ = (id: string, member: string, s: string, e: string, allDay = false): Occurrence => ({
  eventId: id, memberId: member, title: id, start: new Date(s), end: new Date(e), allDay, occurrenceDate: s.slice(0, 10),
});
const Z = (t: string) => `2026-10-10T${t}:00Z`;

describe('findOverlaps', () => {
  it('partial overlap returns the overlap window', () => {
    const o = findOverlaps([occ('A', 'dad', Z('10:00'), Z('12:00')), occ('B', 'mom', Z('11:30'), Z('13:00'))]);
    expect(o).toHaveLength(1);
    expect(o[0]!.start.toISOString()).toBe('2026-10-10T11:30:00.000Z');
    expect(o[0]!.end.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(o[0]!.sameMember).toBe(false);
  });
  it('touching events do not conflict', () => {
    expect(findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'm', Z('11:00'), Z('12:00'))])).toHaveLength(0);
  });
  it('identical start conflicts', () => {
    expect(findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'm', Z('10:00'), Z('10:30'))])).toHaveLength(1);
  });
  it('containment conflicts', () => {
    expect(findOverlaps([occ('A', 'd', Z('09:00'), Z('17:00')), occ('B', 'm', Z('12:00'), Z('13:00'))])).toHaveLength(1);
  });
  it('same-member double booking conflicts and is flagged', () => {
    const o = findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'd', Z('10:30'), Z('11:30'))]);
    expect(o[0]!.sameMember).toBe(true);
  });
  it('all-day events never conflict', () => {
    expect(findOverlaps([occ('A', 'd', '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z', true), occ('B', 'm', Z('10:00'), Z('11:00'))])).toHaveLength(0);
  });
  it('three mutually overlapping events produce 3 pairs', () => {
    const o = findOverlaps([occ('A', 'a', Z('10:00'), Z('12:00')), occ('B', 'b', Z('10:30'), Z('12:30')), occ('C', 'c', Z('11:00'), Z('13:00'))]);
    expect(o).toHaveLength(3);
  });
  it('is order-independent', () => {
    const list = [occ('B', 'm', Z('11:30'), Z('13:00')), occ('A', 'd', Z('10:00'), Z('12:00'))];
    expect(findOverlaps(list)).toHaveLength(1);
  });
});

describe('groupConflicts + dayStatuses', () => {
  it('chains A-B and B-C into one group', () => {
    const list = [occ('A', 'a', Z('10:00'), Z('11:00')), occ('B', 'b', Z('10:30'), Z('12:00')), occ('C', 'c', Z('11:30'), Z('12:30'))];
    const groups = groupConflicts(findOverlaps(list), 'UTC');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences.map((x) => x.eventId).sort()).toEqual(['A', 'B', 'C']);
  });
  it('event crossing midnight marks both days; status conflict beats scheduled', () => {
    const list = [
      occ('A', 'a', '2026-10-10T23:00:00Z', '2026-10-11T02:00:00Z'),
      occ('B', 'b', '2026-10-11T01:00:00Z', '2026-10-11T03:00:00Z'),
      occ('C', 'c', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z'),
    ];
    const groups = groupConflicts(findOverlaps(list), 'UTC');
    const st = dayStatuses(list, groups, 'UTC');
    expect(st['2026-10-10']).toBe('scheduled');
    expect(st['2026-10-11']).toBe('conflict');
    expect(st['2026-10-12']).toBe('scheduled');
    expect(st['2026-10-13']).toBeUndefined();
  });
  it('same event id on different occurrence dates stays separate', () => {
    const a1 = { ...occ('S', 'a', '2026-10-10T10:00:00Z', '2026-10-10T11:00:00Z'), occurrenceDate: '2026-10-10' };
    const a2 = { ...occ('S', 'a', '2026-10-11T10:00:00Z', '2026-10-11T11:00:00Z'), occurrenceDate: '2026-10-11' };
    const b = occ('B', 'b', '2026-10-11T10:30:00Z', '2026-10-11T11:30:00Z');
    const groups = groupConflicts(findOverlaps([a1, a2, b]), 'UTC');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences).toHaveLength(2);
    expect(groups[0]!.days).toEqual(['2026-10-11']);
  });
});
