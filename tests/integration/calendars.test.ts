import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily, joinAs, randomIp, PASSWORD } from '../helpers/services';
import type { Db } from '@/server/db/client';
import { calendars, members, sessions } from '@/server/db/schema';
import {
  createCalendar, joinCalendar, getCalendar, updateCalendar, changePassword, recoverPassword, deleteCalendar,
} from '@/server/services/calendars';
import { resolveSession } from '@/server/auth/session';

let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await setup()); });
afterAll(async () => { await close(); await stopTestServer(); });

const GENERIC = { code: 'UNAUTHENTICATED', message: 'Invalid calendar ID or password' };

describe('createCalendar', () => {
  it('persists only hashes, assigns owner, returns recovery code once', async () => {
    const f = await makeFamily(db);
    const [row] = await db.select().from(calendars).where(eq(calendars.id, f.calendar.id));
    expect(row!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row!.passwordHash).not.toContain(PASSWORD);
    expect(row!.recoveryHash).not.toContain(f.recoveryCode);
    expect(row!.code).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(row!.ownerMemberId).toBe(f.owner.memberId);
    expect(f.owner.role).toBe('owner');
    expect(f.recoveryCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
  it('concurrent creates yield distinct codes', async () => {
    const all = await Promise.all(Array.from({ length: 4 }, () => makeFamily(db)));
    expect(new Set(all.map((a) => a.code)).size).toBe(4);
  });
});

describe('joinCalendar', () => {
  it('joins with correct password as a member', async () => {
    const f = await makeFamily(db);
    const r = await joinCalendar(db, { code: f.code, memberName: 'Mom', password: PASSWORD }, { ip: randomIp() });
    expect(r.status).toBe('joined');
    expect(r.member!.role).toBe('member');
    expect(r.member!.name).toBe('Mom');
  });
  it('unknown code and wrong password give the identical error', async () => {
    const f = await makeFamily(db);
    const wrong = joinCalendar(db, { code: f.code, memberName: 'Mom', password: 'nope-nope' }, { ip: randomIp() });
    const unknown = joinCalendar(db, { code: 'ZZZZ-0000', memberName: 'Mom', password: PASSWORD }, { ip: randomIp() });
    await expect(wrong).rejects.toMatchObject(GENERIC);
    await expect(unknown).rejects.toMatchObject(GENERIC);
  });
  it('locks the calendar after 5 wrong attempts even for the right password', async () => {
    const f = await makeFamily(db);
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      await expect(joinCalendar(db, { code: f.code, memberName: 'X', password: 'wrong-pass' }, { ip })).rejects.toMatchObject(GENERIC);
    }
    await expect(joinCalendar(db, { code: f.code, memberName: 'X', password: PASSWORD }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('without a known client IP, failures lock only the targeted calendar, not everyone', async () => {
    const a = await makeFamily(db); const b = await makeFamily(db);
    for (let i = 0; i < 5; i++) {
      await expect(joinCalendar(db, { code: a.code, memberName: 'X', password: 'wrong-pass' }, { ip: 'unknown' })).rejects.toMatchObject(GENERIC);
    }
    await expect(joinCalendar(db, { code: a.code, memberName: 'X', password: PASSWORD }, { ip: 'unknown' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const ok = await joinCalendar(db, { code: b.code, memberName: 'Mom', password: PASSWORD }, { ip: 'unknown' });
    expect(ok.status).toBe('joined');
  });
  it('asks for confirmation when the name exists (case-insensitive) and does not create a duplicate', async () => {
    const f = await makeFamily(db);
    await joinAs(db, f.code, 'Mom');
    const r = await joinCalendar(db, { code: f.code, memberName: 'mom', password: PASSWORD }, { ip: randomIp() });
    expect(r.status).toBe('needs_confirmation');
    const rows = await db.select().from(members).where(eq(members.calendarId, f.calendar.id));
    expect(rows.filter((m) => m.nameKey === 'mom')).toHaveLength(1);
    const again = await joinCalendar(db, { code: f.code, memberName: 'mom', password: PASSWORD, confirmExisting: true }, { ip: randomIp() });
    expect(again.status).toBe('joined');
    expect(again.member!.name).toBe('Mom');
  });
  it('concurrent confirmed joins as the same name create exactly one member', async () => {
    const f = await makeFamily(db);
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      joinCalendar(db, { code: f.code, memberName: 'Sam', password: PASSWORD, confirmExisting: true }, { ip: randomIp() })));
    expect(new Set(rs.map((r) => r.member!.id)).size).toBe(1);
    const rows = await db.select().from(members).where(eq(members.calendarId, f.calendar.id));
    expect(rows.filter((m) => m.nameKey === 'sam')).toHaveLength(1);
  });
  it('concurrent unconfirmed joins never create duplicates', async () => {
    const f = await makeFamily(db);
    await Promise.all(Array.from({ length: 4 }, () =>
      joinCalendar(db, { code: f.code, memberName: 'Lee', password: PASSWORD }, { ip: randomIp() })));
    const rows = await db.select().from(members).where(eq(members.calendarId, f.calendar.id));
    expect(rows.filter((m) => m.nameKey === 'lee')).toHaveLength(1);
  });
});

describe('calendar settings', () => {
  it('owner updates; member forbidden; invalid timezone rejected', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const u = await updateCalendar(db, f.owner, { name: 'New Name', timezone: 'UTC', settings: { membersCanEditAll: false } });
    expect(u.name).toBe('New Name');
    expect(u.settings.membersCanEditAll).toBe(false);
    await expect(updateCalendar(db, mom, { name: 'Hacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateCalendar(db, f.owner, { timezone: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('never returns another calendar data', async () => {
    const a = await makeFamily(db, { familyName: 'Alpha' });
    const b = await makeFamily(db, { familyName: 'Beta' });
    expect((await getCalendar(db, a.owner)).name).toBe('Alpha');
    expect((await getCalendar(db, b.owner)).name).toBe('Beta');
    expect((await getCalendar(db, a.owner)).me.id).toBe(a.owner.memberId);
  });
});

describe('passwords', () => {
  it('changePassword requires the current password and revokes other sessions', async () => {
    const f = await makeFamily(db);
    const other = await createSessionFor(f);
    await expect(changePassword(db, f.owner, 'wrong-pass', 'brand new pw', f.ownerToken)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await changePassword(db, f.owner, PASSWORD, 'brand new pw', f.ownerToken);
    await expect(joinCalendar(db, { code: f.code, memberName: 'Z', password: PASSWORD }, { ip: randomIp() })).rejects.toMatchObject(GENERIC);
    expect((await joinCalendar(db, { code: f.code, memberName: 'Z', password: 'brand new pw' }, { ip: randomIp() })).status).toBe('joined');
    expect(await resolveSession(db, other)).toBeNull();
    expect(await resolveSession(db, f.ownerToken)).not.toBeNull();
  });
  it('member cannot change the password', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    await expect(changePassword(db, mom, PASSWORD, 'brand new pw')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('recovery rotates password and recovery code and revokes all sessions', async () => {
    const f = await makeFamily(db);
    const ip = randomIp();
    const r = await recoverPassword(db, f.code, f.recoveryCode, 'recovered pw 1', { ip });
    expect(r.recoveryCode).not.toBe(f.recoveryCode);
    expect(await resolveSession(db, f.ownerToken)).toBeNull();
    expect((await joinCalendar(db, { code: f.code, memberName: 'Q', password: 'recovered pw 1' }, { ip: randomIp() })).status).toBe('joined');
    await expect(recoverPassword(db, f.code, f.recoveryCode, 'another pw 22', { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('wrong recovery codes count toward lockout', async () => {
    const f = await makeFamily(db);
    for (let i = 0; i < 5; i++) {
      await expect(recoverPassword(db, f.code, 'AAAA-BBBB-CCCC', 'whatever pw 1', { ip: randomIp() })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    await expect(recoverPassword(db, f.code, f.recoveryCode, 'whatever pw 1', { ip: randomIp() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('deleteCalendar', () => {
  it('requires owner and the exact calendar name, then purges everything', async () => {
    const f = await makeFamily(db, { familyName: 'Purge Me' });
    const mom = await joinAs(db, f.code, 'Mom');
    await expect(deleteCalendar(db, mom, 'Purge Me')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteCalendar(db, f.owner, 'wrong name')).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteCalendar(db, f.owner, 'Purge Me');
    expect(await db.select().from(calendars).where(eq(calendars.id, f.calendar.id))).toHaveLength(0);
    expect(await db.select().from(members).where(eq(members.calendarId, f.calendar.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.calendarId, f.calendar.id))).toHaveLength(0);
  });
});

async function createSessionFor(f: { code: string }) {
  const r = await joinCalendar(db, { code: f.code, memberName: 'Phone', password: PASSWORD }, { ip: randomIp() });
  return r.sessionToken!;
}

describe('createCalendar rate limit', () => {
  it('limits calendar creation per IP', async () => {
    const ip = randomIp();
    const input = { familyName: 'Spam', memberName: 'Bot', password: PASSWORD, timezone: 'UTC' };
    for (let i = 0; i < 10; i++) await createCalendar(db, input, { ip });
    await expect(createCalendar(db, input, { ip })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
