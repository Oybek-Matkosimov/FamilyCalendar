import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily, joinAs } from '../helpers/services';
import { createDb, type Db } from '@/server/db/client';
import { events, eventAudit } from '@/server/db/schema';
import { updateCalendar } from '@/server/services/calendars';
import { removeMember } from '@/server/services/members';
import {
  createEvent, updateEvent, deleteEvent, restoreEvent, listEvents, getConflicts, getEventHistory,
} from '@/server/services/events';

let db: Db; let url: string; let close: () => Promise<void>;
beforeAll(async () => { ({ db, url, close } = await setup()); });
afterAll(async () => { await close(); await stopTestServer(); });

const input = (memberId: string, over: Record<string, unknown> = {}) => ({
  title: 'Gym', memberId, allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T19:30', ...over,
}) as Parameters<typeof createEvent>[2];

const DAY = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-11T00:00:00Z') };
const WEEK = { from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z') };

async function utcFamily() {
  const f = await makeFamily(db, { timezone: 'UTC' });
  const dad = await joinAs(db, f.code, 'Dad');
  const mom = await joinAs(db, f.code, 'Mom');
  return { ...f, dad, mom };
}

describe('createEvent', () => {
  it('stores UTC times, creator/editor, version 1 and an audit row', async () => {
    const f = await makeFamily(db); // Australia/Melbourne
    const ev = await createEvent(db, f.owner, input(f.owner.memberId, { description: 'Leg day', location: 'Gym' }));
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.startUtc.toISOString()).toBe('2026-10-10T07:00:00.000Z');
    expect(row!.endUtc.toISOString()).toBe('2026-10-10T08:30:00.000Z');
    expect(row!.createdBy).toBe(f.owner.memberId);
    expect(row!.updatedBy).toBe(f.owner.memberId);
    expect(row!.version).toBe(1);
    expect(ev.createdBy.name).toBe('Oybek');
    const audit = await db.select().from(eventAudit).where(eq(eventAudit.eventId, ev.eventId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('create');
    expect(audit[0]!.before).toBeNull();
    expect((audit[0]!.after as { title: string }).title).toBe('Gym');
  });

  it('rejects members of another calendar and removed members without writing rows', async () => {
    const a = await makeFamily(db); const b = await makeFamily(db);
    await expect(createEvent(db, a.owner, input(b.owner.memberId))).rejects.toMatchObject({ code: 'VALIDATION' });
    const kid = await joinAs(db, a.code, 'Kid');
    await removeMember(db, a.owner, kid.memberId, { eventsPolicy: 'keep' });
    await expect(createEvent(db, a.owner, input(kid.memberId))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(events).where(eq(events.calendarId, a.calendar.id))).toHaveLength(0);
  });

  it('rejects invalid times', async () => {
    const f = await utcFamily();
    const bad = (over: Record<string, unknown>) => createEvent(db, f.owner, input(f.owner.memberId, over));
    await expect(bad({ start: '2026-10-10T10:00', end: '2026-10-10T10:00' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bad({ start: '2026-10-10T10:00', end: '2026-10-18T10:01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bad({ start: '2026-10-10T23:00', end: '2026-10-10T01:00' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bad({ start: '2026-02-30T10:00', end: '2026-02-30T11:00' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bad({ title: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('allows events crossing midnight and shows them on both days', async () => {
    const f = await utcFamily();
    await createEvent(db, f.owner, input(f.owner.memberId, { start: '2026-10-10T23:00', end: '2026-10-11T01:00' }));
    const r = await listEvents(db, f.owner, { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z') });
    expect(r.occurrences).toHaveLength(1);
    expect(r.dayStatus['2026-10-10']).toBe('scheduled');
    expect(r.dayStatus['2026-10-11']).toBe('scheduled');
    const second = await listEvents(db, f.owner, { from: new Date('2026-10-11T00:00:00Z'), to: new Date('2026-10-11T12:00:00Z') });
    expect(second.occurrences).toHaveLength(1);
  });

  it('supports all-day events that never conflict', async () => {
    const f = await utcFamily();
    await createEvent(db, f.owner, input(f.owner.memberId, { title: 'Birthday', allDay: true, start: '2026-10-10T00:00', end: '2026-10-10T00:00' }));
    await createEvent(db, f.dad, input(f.dad.memberId, { start: '2026-10-10T10:00', end: '2026-10-10T11:00' }));
    const r = await listEvents(db, f.owner, DAY);
    expect(r.occurrences).toHaveLength(2);
    expect(r.conflicts).toHaveLength(0);
    expect(r.dayStatus['2026-10-10']).toBe('scheduled');
  });
});

describe('idempotency', () => {
  it('same key twice (and concurrently) creates one event', async () => {
    const f = await utcFamily();
    const a = await createEvent(db, f.owner, input(f.owner.memberId), 'key-1');
    const b = await createEvent(db, f.owner, input(f.owner.memberId), 'key-1');
    expect(b.eventId).toBe(a.eventId);
    const rs = await Promise.all(Array.from({ length: 5 }, () => createEvent(db, f.owner, input(f.owner.memberId, { title: 'Race' }), 'key-2')));
    expect(new Set(rs.map((r) => r.eventId)).size).toBe(1);
    expect(await db.select().from(events).where(eq(events.calendarId, f.calendar.id))).toHaveLength(2);
  });
  it('same key with different data is a conflict', async () => {
    const f = await utcFamily();
    await createEvent(db, f.owner, input(f.owner.memberId), 'key-3');
    await expect(createEvent(db, f.owner, input(f.owner.memberId, { title: 'Different' }), 'key-3')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('updateEvent', () => {
  it('bumps version, records editor and audit before/after, keeps creator', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId));
    const up = await updateEvent(db, f.mom, ev.eventId, { title: 'Gym (legs)', version: 1, scope: 'series' });
    expect(up.title).toBe('Gym (legs)');
    expect(up.version).toBe(2);
    expect(up.updatedBy.name).toBe('Mom');
    expect(up.createdBy.name).toBe('Oybek');
    const audit = await db.select().from(eventAudit).where(eq(eventAudit.eventId, ev.eventId));
    const last = audit.find((a) => a.action === 'update')!;
    expect((last.before as { title: string }).title).toBe('Gym');
    expect((last.after as { title: string }).title).toBe('Gym (legs)');
  });

  it('rejects a stale version and leaves the row unchanged', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId));
    await updateEvent(db, f.owner, ev.eventId, { title: 'First', version: 1, scope: 'series' });
    await expect(updateEvent(db, f.mom, ev.eventId, { title: 'Second', version: 1, scope: 'series' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: 'This event was changed by someone else. Review the latest version.' });
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.title).toBe('First');
  });

  it('two concurrent updates with the same version: exactly one wins', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId));
    const rs = await Promise.allSettled([
      updateEvent(db, f.owner, ev.eventId, { title: 'A', version: 1, scope: 'series' }),
      updateEvent(db, f.mom, ev.eventId, { title: 'B', version: 1, scope: 'series' }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects changes that make the event invalid (and does not bump the version)', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId));
    await expect(updateEvent(db, f.owner, ev.eventId, { end: '2026-10-10T17:00', version: 1, scope: 'series' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.version).toBe(1);
  });
});

describe('permissions', () => {
  it('editing others is configurable; deleting others is owner-only; own is fine', async () => {
    const f = await utcFamily();
    const ownerEv = await createEvent(db, f.owner, input(f.owner.memberId));
    await updateEvent(db, f.mom, ownerEv.eventId, { title: 'Edited by mom', version: 1, scope: 'series' });
    await updateCalendar(db, f.owner, { settings: { membersCanEditAll: false } });
    await expect(updateEvent(db, f.mom, ownerEv.eventId, { title: 'Nope', version: 2, scope: 'series' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteEvent(db, f.mom, ownerEv.eventId, { version: 2, scope: 'series' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const momEv = await createEvent(db, f.mom, input(f.mom.memberId, { title: 'Mine' }));
    await updateEvent(db, f.mom, momEv.eventId, { title: 'Still mine', version: 1, scope: 'series' });
    await deleteEvent(db, f.mom, momEv.eventId, { version: 2, scope: 'series' });
    await deleteEvent(db, f.owner, ownerEv.eventId, { version: 2, scope: 'series' });
  });
});

describe('delete and restore', () => {
  it('soft-deletes with audit, hides from lists, 404 on second delete, owner-only restore', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.mom, input(f.mom.memberId));
    await deleteEvent(db, f.mom, ev.eventId, { version: 1, scope: 'series' });
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.deletedAt).not.toBeNull();
    expect((await listEvents(db, f.owner, DAY)).occurrences).toHaveLength(0);
    await expect(deleteEvent(db, f.mom, ev.eventId, { version: 2, scope: 'series' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(restoreEvent(db, f.mom, ev.eventId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const back = await restoreEvent(db, f.owner, ev.eventId);
    expect(back.eventId).toBe(ev.eventId);
    expect((await listEvents(db, f.owner, DAY)).occurrences).toHaveLength(1);
    const actions = (await db.select().from(eventAudit).where(eq(eventAudit.eventId, ev.eventId))).map((a) => a.action).sort();
    expect(actions).toEqual(['create', 'delete', 'restore']);
  });
});

describe('cross-calendar isolation', () => {
  it('another calendar cannot see, edit, delete, restore or read history of an event', async () => {
    const a = await utcFamily(); const b = await utcFamily();
    const ev = await createEvent(db, a.owner, input(a.owner.memberId));
    await expect(updateEvent(db, b.owner, ev.eventId, { title: 'x', version: 1, scope: 'series' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteEvent(db, b.owner, ev.eventId, { version: 1, scope: 'series' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getEventHistory(db, b.owner, ev.eventId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(restoreEvent(db, b.owner, ev.eventId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listEvents(db, b.owner, DAY)).occurrences).toHaveLength(0);
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.title).toBe('Gym');
    expect(row!.deletedAt).toBeNull();
  });
});

describe('listEvents', () => {
  it('uses half-open range boundaries, member filter, literal search', async () => {
    const f = await utcFamily();
    await createEvent(db, f.owner, input(f.owner.memberId, { title: 'Ends at from', start: '2026-10-09T23:00', end: '2026-10-10T00:00' }));
    await createEvent(db, f.owner, input(f.owner.memberId, { title: 'Starts at to', start: '2026-10-11T00:00', end: '2026-10-11T01:00' }));
    await createEvent(db, f.dad, input(f.dad.memberId, { title: 'Inside 100% effort', description: 'Hard_Work', start: '2026-10-10T10:00', end: '2026-10-10T11:00' }));
    await createEvent(db, f.mom, input(f.mom.memberId, { title: 'Brunch', start: '2026-10-10T12:00', end: '2026-10-10T13:00' }));
    const all = await listEvents(db, f.owner, DAY);
    expect(all.occurrences.map((o) => o.title)).toEqual(['Inside 100% effort', 'Brunch']);
    expect((await listEvents(db, f.owner, { ...DAY, memberId: f.mom.memberId })).occurrences.map((o) => o.title)).toEqual(['Brunch']);
    expect((await listEvents(db, f.owner, { ...DAY, search: 'BRUN' })).occurrences.map((o) => o.title)).toEqual(['Brunch']);
    expect((await listEvents(db, f.owner, { ...DAY, search: '%' })).occurrences.map((o) => o.title)).toEqual(['Inside 100% effort']);
    expect((await listEvents(db, f.owner, { ...DAY, search: 'hard_w' })).occurrences).toHaveLength(1);
    expect((await listEvents(db, f.owner, { ...DAY, search: '_' })).occurrences).toHaveLength(1);
  });

  it('rejects invalid ranges', async () => {
    const f = await utcFamily();
    await expect(listEvents(db, f.owner, { from: DAY.to, to: DAY.from })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(listEvents(db, f.owner, { from: new Date('2020-01-01'), to: new Date('2026-01-01') })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('marks events of removed members as former members', async () => {
    const f = await utcFamily();
    await createEvent(db, f.mom, input(f.mom.memberId));
    await removeMember(db, f.owner, f.mom.memberId, { eventsPolicy: 'keep' });
    const r = await listEvents(db, f.owner, DAY);
    expect(r.occurrences[0]!.memberRemoved).toBe(true);
    expect(r.occurrences[0]!.memberName).toBe('Mom');
  });
});

describe('recurring events', () => {
  const school = (memberId: string, over: Record<string, unknown> = {}) =>
    input(memberId, { title: 'School', start: '2026-10-05T08:30', end: '2026-10-05T15:30', recurrence: { freq: 'weekdays' }, ...over });

  it('expands Monday to Friday only', async () => {
    const f = await utcFamily();
    await createEvent(db, f.mom, school(f.mom.memberId));
    const r = await listEvents(db, f.owner, WEEK);
    expect(r.occurrences.map((o) => o.occurrenceDate)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(r.occurrences.every((o) => o.isRecurring)).toBe(true);
    expect(r.occurrences[0]!.recurrence).toEqual({ freq: 'weekdays' });
  });

  it('an until date in the past of the range yields nothing', async () => {
    const f = await utcFamily();
    await createEvent(db, f.mom, school(f.mom.memberId, { recurrence: { freq: 'daily', until: '2026-10-04' }, start: '2026-10-01T08:30', end: '2026-10-01T09:30' }));
    expect((await listEvents(db, f.owner, WEEK)).occurrences).toHaveLength(0);
  });

  it('edit this occurrence creates a linked one-off and skips the original date', async () => {
    const f = await utcFamily();
    const created = await createEvent(db, f.mom, school(f.mom.memberId));
    const one = await updateEvent(db, f.mom, created.eventId, {
      scope: 'this', occurrenceDate: '2026-10-07', title: 'School (late start)', start: '2026-10-07T10:00', end: '2026-10-07T15:30', version: 1,
    });
    expect(one.seriesId).toBe(created.eventId);
    expect(one.isRecurring).toBe(false);
    const r = await listEvents(db, f.owner, WEEK);
    expect(r.occurrences).toHaveLength(5);
    expect(r.occurrences.find((o) => o.occurrenceDate === '2026-10-07')!.title).toBe('School (late start)');
    const [parent] = await db.select().from(events).where(eq(events.id, created.eventId));
    expect(parent!.version).toBe(2);
    expect(parent!.exceptions).toContain('2026-10-07');
  });

  it('delete this occurrence adds an exception; delete series removes all', async () => {
    const f = await utcFamily();
    const created = await createEvent(db, f.mom, school(f.mom.memberId));
    await deleteEvent(db, f.mom, created.eventId, { scope: 'this', occurrenceDate: '2026-10-06', version: 1 });
    expect((await listEvents(db, f.owner, WEEK)).occurrences.map((o) => o.occurrenceDate)).toEqual(['2026-10-05', '2026-10-07', '2026-10-08', '2026-10-09']);
    await expect(deleteEvent(db, f.mom, created.eventId, { scope: 'this', version: 2 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteEvent(db, f.mom, created.eventId, { scope: 'series', version: 2 });
    expect((await listEvents(db, f.owner, WEEK)).occurrences).toHaveLength(0);
  });

  it('edit series can stop recurrence', async () => {
    const f = await utcFamily();
    const created = await createEvent(db, f.mom, school(f.mom.memberId));
    await updateEvent(db, f.mom, created.eventId, { recurrence: null, version: 1, scope: 'series' });
    expect((await listEvents(db, f.owner, WEEK)).occurrences).toHaveLength(1);
  });
});

describe('conflicts', () => {
  const at = (memberId: string, title: string, start: string, end: string) => input(memberId, { title, start, end });

  it('partial overlap marks the day red with a readable summary', async () => {
    const f = await utcFamily();
    await createEvent(db, f.dad, at(f.dad.memberId, 'Work', '2026-10-10T10:00', '2026-10-10T12:00'));
    await createEvent(db, f.mom, at(f.mom.memberId, 'Uni', '2026-10-10T11:30', '2026-10-10T13:00'));
    const r = await listEvents(db, f.owner, DAY);
    expect(r.dayStatus['2026-10-10']).toBe('conflict');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.overlaps[0]!.summary).toBe('Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM.');
    expect(r.conflicts[0]!.members.map((m) => m.name).sort()).toEqual(['Dad', 'Mom']);
    expect((await getConflicts(db, f.owner, DAY.from, DAY.to)).conflicts).toHaveLength(1);
  });

  it('touching events are scheduled, not conflicting; empty day has no status', async () => {
    const f = await utcFamily();
    await createEvent(db, f.dad, at(f.dad.memberId, 'A', '2026-10-10T10:00', '2026-10-10T11:00'));
    await createEvent(db, f.mom, at(f.mom.memberId, 'B', '2026-10-10T11:00', '2026-10-10T12:00'));
    const r = await listEvents(db, f.owner, { from: DAY.from, to: new Date('2026-10-12T00:00:00Z') });
    expect(r.dayStatus['2026-10-10']).toBe('scheduled');
    expect(r.dayStatus['2026-10-11']).toBeUndefined();
    expect(r.conflicts).toHaveLength(0);
  });

  it('same member double-booked is reported as such', async () => {
    const f = await utcFamily();
    await createEvent(db, f.dad, at(f.dad.memberId, 'A', '2026-10-10T10:00', '2026-10-10T11:00'));
    await createEvent(db, f.dad, at(f.dad.memberId, 'B', '2026-10-10T10:30', '2026-10-10T11:30'));
    const r = await listEvents(db, f.owner, DAY);
    expect(r.conflicts[0]!.overlaps[0]!.sameMember).toBe(true);
    expect(r.conflicts[0]!.overlaps[0]!.summary).toBe('Dad is double-booked from 10:30 AM to 11:00 AM.');
  });

  it('a recurring series only conflicts on the date it overlaps; deleting clears it; filtering does not hide it', async () => {
    const f = await utcFamily();
    await createEvent(db, f.mom, input(f.mom.memberId, { title: 'School', start: '2026-10-05T08:30', end: '2026-10-05T15:30', recurrence: { freq: 'weekdays' } }));
    const dentist = await createEvent(db, f.dad, at(f.dad.memberId, 'Dentist', '2026-10-07T14:00', '2026-10-07T16:00'));
    const r = await listEvents(db, f.owner, { ...WEEK, memberId: f.dad.memberId });
    expect(r.dayStatus['2026-10-06']).toBe('scheduled');
    expect(r.dayStatus['2026-10-07']).toBe('conflict');
    expect(r.occurrences).toHaveLength(1);
    await deleteEvent(db, f.dad, dentist.eventId, { version: 1, scope: 'series' });
    const after = await listEvents(db, f.owner, WEEK);
    expect(after.conflicts).toHaveLength(0);
    expect(after.dayStatus['2026-10-07']).toBe('scheduled');
  });
});

describe('history and persistence', () => {
  it('returns chronological entries with actor names, even for removed members', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId));
    await updateEvent(db, f.mom, ev.eventId, { title: 'Changed', version: 1, scope: 'series' });
    await removeMember(db, f.owner, f.mom.memberId, { eventsPolicy: 'keep' });
    const h = await getEventHistory(db, f.owner, ev.eventId);
    expect(h.map((x) => [x.action, x.actorName])).toEqual([['create', 'Oybek'], ['update', 'Mom']]);
  });

  it('data is visible from a brand new connection', async () => {
    const f = await utcFamily();
    const ev = await createEvent(db, f.owner, input(f.owner.memberId, { title: 'Dentist appointment' }));
    const fresh = createDb(url, 2);
    try {
      const [row] = await fresh.db.select().from(events).where(eq(events.id, ev.eventId));
      expect(row!.title).toBe('Dentist appointment');
    } finally {
      await fresh.sql.end();
    }
  });
});
