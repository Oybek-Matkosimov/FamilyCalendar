import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily, joinAs, randomIp, PASSWORD } from '../helpers/services';
import type { Db } from '@/server/db/client';
import { events, invites, members } from '@/server/db/schema';
import { createCalendar, joinCalendar } from '@/server/services/calendars';
import { createInvite } from '@/server/services/invites';
import { createEvent, deleteEvent, listEvents, updateEvent } from '@/server/services/events';
import { assertNotLocked, recordFailure } from '@/server/auth/lockout';

let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await setup()); });
afterAll(async () => { await close(); await stopTestServer(); });

describe('signing in as the owner needs the recovery code', () => {
  it('a member (or anyone with the password) cannot become the owner by claiming the name', async () => {
    const f = await makeFamily(db, { memberName: 'Oybek' });
    const first = await joinCalendar(db, { code: f.code, memberName: 'oybek', password: PASSWORD, confirmExisting: true }, { ip: randomIp() });
    expect(first.status).toBe('needs_owner_proof');
    expect(first.sessionToken).toBeUndefined();
    await expect(joinCalendar(db, { code: f.code, memberName: 'Oybek', password: PASSWORD, confirmExisting: true, recoveryCode: 'AAAA-BBBB-CCCC' }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('the owner can sign in on a new device with the recovery code', async () => {
    const f = await makeFamily(db, { memberName: 'Oybek' });
    const r = await joinCalendar(db, { code: f.code, memberName: 'Oybek', password: PASSWORD, confirmExisting: true, recoveryCode: f.recoveryCode }, { ip: randomIp() });
    expect(r.status).toBe('joined');
    expect(r.member!.role).toBe('owner');
    expect(r.member!.id).toBe(f.owner.memberId);
  });
  it('wrong recovery codes count toward the lockout', async () => {
    const f = await makeFamily(db, { memberName: 'Oybek' });
    for (let i = 0; i < 5; i++) {
      await expect(joinCalendar(db, { code: f.code, memberName: 'Oybek', password: PASSWORD, confirmExisting: true, recoveryCode: 'AAAA-BBBB-CCCC' }, { ip: randomIp() }))
        .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    await expect(joinCalendar(db, { code: f.code, memberName: 'Oybek', password: PASSWORD, confirmExisting: true, recoveryCode: f.recoveryCode }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('ordinary members still confirm with just the password', async () => {
    const f = await makeFamily(db);
    await joinAs(db, f.code, 'Mom');
    const r = await joinCalendar(db, { code: f.code, memberName: 'mom', password: PASSWORD, confirmExisting: true }, { ip: randomIp() });
    expect(r.status).toBe('joined');
    expect(r.member!.role).toBe('member');
  });
});

describe('single-use invites', () => {
  const usesOf = async (id: string) => (await db.select().from(invites).where(eq(invites.id, id)))[0]!.uses;

  it('are not consumed by the "Is this you?" step, and confirming still works', async () => {
    const f = await makeFamily(db);
    await joinAs(db, f.code, 'Grandma');
    const inv = await createInvite(db, f.owner, { maxUses: 1 });
    const ask = await joinCalendar(db, { code: f.code, memberName: 'grandma', password: PASSWORD, inviteToken: inv.token }, { ip: randomIp() });
    expect(ask.status).toBe('needs_confirmation');
    expect(await usesOf(inv.id)).toBe(0);
    const ok = await joinCalendar(db, { code: f.code, memberName: 'grandma', password: PASSWORD, inviteToken: inv.token, confirmExisting: true }, { ip: randomIp() });
    expect(ok.status).toBe('joined');
    expect(await usesOf(inv.id)).toBe(0); // an existing member signing in is not a new person
  });
  it('are consumed only when a new person actually joins', async () => {
    const f = await makeFamily(db);
    const inv = await createInvite(db, f.owner, { maxUses: 1 });
    const ok = await joinCalendar(db, { code: f.code, memberName: 'Newcomer', password: PASSWORD, inviteToken: inv.token }, { ip: randomIp() });
    expect(ok.status).toBe('joined');
    expect(await usesOf(inv.id)).toBe(1);
    await expect(joinCalendar(db, { code: f.code, memberName: 'Second', password: PASSWORD, inviteToken: inv.token }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.select().from(members).where(and(eq(members.calendarId, f.calendar.id), eq(members.nameKey, 'second')))).toHaveLength(0);
  });
});

describe('deleting a whole series', () => {
  it('also removes the individually edited dates of that series', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    const series = await createEvent(db, f.owner, {
      title: 'Soccer', memberId: f.owner.memberId, allDay: false, start: '2026-10-05T16:00', end: '2026-10-05T17:00', recurrence: { freq: 'weekly' },
    });
    await updateEvent(db, f.owner, series.eventId, { scope: 'this', occurrenceDate: '2026-10-12', title: 'Soccer (final)', version: 1 });
    const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
    expect((await listEvents(db, f.owner, range)).occurrences.map((o) => o.title)).toContain('Soccer (final)');
    await deleteEvent(db, f.owner, series.eventId, { version: 2, scope: 'series' });
    expect((await listEvents(db, f.owner, range)).occurrences).toHaveLength(0);
    const rows = await db.select().from(events).where(eq(events.calendarId, f.calendar.id));
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
  });
  it('deleting only one date leaves the edited ones alone', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    const series = await createEvent(db, f.owner, {
      title: 'Soccer', memberId: f.owner.memberId, allDay: false, start: '2026-10-05T16:00', end: '2026-10-05T17:00', recurrence: { freq: 'weekly' },
    });
    await updateEvent(db, f.owner, series.eventId, { scope: 'this', occurrenceDate: '2026-10-12', title: 'Soccer (final)', version: 1 });
    await deleteEvent(db, f.owner, series.eventId, { version: 2, scope: 'this', occurrenceDate: '2026-10-19' });
    const titles = (await listEvents(db, f.owner, { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') })).occurrences.map((o) => o.title);
    expect(titles).toContain('Soccer (final)');
  });
});

describe('far-away dates', () => {
  it('listing and creating in the year 9999 is a clean validation error, not a hang or 500', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    await expect(listEvents(db, f.owner, { from: new Date('9999-01-01T00:00:00Z'), to: new Date('9999-12-31T00:00:00Z') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createEvent(db, f.owner, { title: 'x', memberId: f.owner.memberId, allDay: false, start: '9999-01-01T10:00', end: '9999-01-01T11:00' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createEvent(db, f.owner, { title: 'x', memberId: f.owner.memberId, allDay: false, start: '1850-01-01T10:00', end: '1850-01-01T11:00' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('editing or deleting "this occurrence" on an absurd date is rejected quickly', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    const s = await createEvent(db, f.owner, { title: 'Daily', memberId: f.owner.memberId, allDay: false, start: '2026-10-05T09:00', end: '2026-10-05T10:00', recurrence: { freq: 'daily' } });
    const t0 = Date.now();
    await expect(deleteEvent(db, f.owner, s.eventId, { version: 1, scope: 'this', occurrenceDate: '9999-06-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('without a known client IP (no trusted proxy)', () => {
  it('calendar creation is not throttled through one shared bucket', async () => {
    for (let i = 0; i < 12; i++) {
      await createCalendar(db, { familyName: 'F' + i, memberName: 'Dad', password: PASSWORD, timezone: 'UTC' }, { ip: 'unknown' });
    }
  });
});

describe('lockout', () => {
  it('keeps escalating while someone keeps guessing, instead of resetting after each lock', async () => {
    const key = ['cal:ESCALATE-1'];
    for (let i = 0; i < 5; i++) await recordFailure(db, key);
    await expect(assertNotLocked(db, key)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // lock (1 min) expires; the guesser tries again
    await db.execute(sql`update auth_attempts set locked_until = now() - interval '1 second' where key = 'cal:ESCALATE-1'`);
    await recordFailure(db, key);
    const [row] = (await db.execute(sql`select failures, locked_until > now() + interval '90 seconds' as longer from auth_attempts where key = 'cal:ESCALATE-1'`)) as unknown as { failures: number; longer: boolean }[];
    expect(row!.failures).toBe(6);
    expect(row!.longer).toBe(true); // 2 minute lock, then 4, 8 ... up to 1 hour
  });
  it('measures the 15 minute window from the most recent failure, so a steady guesser never gets a fresh start', async () => {
    const key = ['cal:SLIDING-1'];
    await recordFailure(db, key);
    await db.execute(sql`update auth_attempts set window_start = now() - interval '10 minutes' where key = 'cal:SLIDING-1'`);
    await recordFailure(db, key);
    const [row] = (await db.execute(sql`select failures, window_start > now() - interval '1 minute' as fresh from auth_attempts where key = 'cal:SLIDING-1'`)) as unknown as { failures: number; fresh: boolean }[];
    expect(row!.failures).toBe(2);
    expect(row!.fresh).toBe(true);
  });
  it('still forgives old mistakes after 15 quiet minutes', async () => {
    const key = ['cal:FORGIVE-1'];
    for (let i = 0; i < 4; i++) await recordFailure(db, key);
    await db.execute(sql`update auth_attempts set window_start = now() - interval '16 minutes' where key = 'cal:FORGIVE-1'`);
    await recordFailure(db, key);
    await expect(assertNotLocked(db, key)).resolves.toBeUndefined();
  });
});
