import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily, joinAs, randomIp, PASSWORD } from '../helpers/services';
import type { Db } from '@/server/db/client';
import { events, eventAudit, invites, members } from '@/server/db/schema';
import { joinCalendar } from '@/server/services/calendars';
import { listMembers, removeMember } from '@/server/services/members';
import { createInvite, listInvites, revokeInvite, getJoinInfo } from '@/server/services/invites';
import { resolveSession, createSession } from '@/server/auth/session';
import { hashToken } from '@/server/auth/tokens';

let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await setup()); });
afterAll(async () => { await close(); await stopTestServer(); });

const addEvent = async (calendarId: string, memberId: string, title = 'x') => {
  const [e] = await db.insert(events).values({
    calendarId, memberId, title, startUtc: new Date(Date.now() + 3600e3), endUtc: new Date(Date.now() + 7200e3),
    tz: 'UTC', createdBy: memberId, updatedBy: memberId,
  }).returning();
  return e!;
};

describe('listMembers', () => {
  it('lists active members only without secrets', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    await joinAs(db, f.code, 'Kid');
    await removeMember(db, f.owner, mom.memberId, { eventsPolicy: 'keep' });
    const list = await listMembers(db, f.owner);
    expect(list.map((m) => m.name).sort()).toEqual(['Kid', 'Oybek']);
    expect(JSON.stringify(list)).not.toMatch(/nameKey|calendarId|hash/i);
  });
});

describe('removeMember', () => {
  it('keep: member removed, events stay, session dies, name can be reused as a new member', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const { token } = await createSession(db, f.calendar.id, mom.memberId);
    const ev = await addEvent(f.calendar.id, mom.memberId);
    await removeMember(db, f.owner, mom.memberId, { eventsPolicy: 'keep' });
    expect(await resolveSession(db, token)).toBeNull();
    const [still] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(still!.deletedAt).toBeNull();
    const again = await joinAs(db, f.code, 'Mom');
    expect(again.memberId).not.toBe(mom.memberId);
  });

  it('delete: soft-deletes the events and writes audit rows', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const ev = await addEvent(f.calendar.id, mom.memberId);
    await removeMember(db, f.owner, mom.memberId, { eventsPolicy: 'delete' });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row!.deletedAt).not.toBeNull();
    const audit = await db.select().from(eventAudit).where(eq(eventAudit.eventId, ev.id));
    expect(audit.map((a) => a.action)).toEqual(['delete']);
    expect(audit[0]!.actorMemberId).toBe(f.owner.memberId);
  });

  it('reassign: moves events, bumps version, audits; rejects foreign and removed targets', async () => {
    const f = await makeFamily(db);
    const other = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const dad = await joinAs(db, f.code, 'Dad');
    const gone = await joinAs(db, f.code, 'Gone');
    await removeMember(db, f.owner, gone.memberId, { eventsPolicy: 'keep' });
    const ev = await addEvent(f.calendar.id, mom.memberId);
    await expect(removeMember(db, f.owner, mom.memberId, { eventsPolicy: { reassignTo: other.owner.memberId } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(removeMember(db, f.owner, mom.memberId, { eventsPolicy: { reassignTo: gone.memberId } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(removeMember(db, f.owner, mom.memberId, { eventsPolicy: { reassignTo: mom.memberId } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await removeMember(db, f.owner, mom.memberId, { eventsPolicy: { reassignTo: dad.memberId } });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row!.memberId).toBe(dad.memberId);
    expect(row!.version).toBe(2);
    const audit = await db.select().from(eventAudit).where(eq(eventAudit.eventId, ev.id));
    expect(audit.map((a) => a.action)).toEqual(['update']);
  });

  it('failed removal rolls back (nothing half-applied)', async () => {
    const f = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const ev = await addEvent(f.calendar.id, mom.memberId);
    await expect(removeMember(db, f.owner, mom.memberId, { eventsPolicy: { reassignTo: mom.memberId } })).rejects.toBeTruthy();
    const [m] = await db.select().from(members).where(eq(members.id, mom.memberId));
    expect(m!.removedAt).toBeNull();
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row!.version).toBe(1);
  });

  it('owner cannot be removed; members cannot remove; foreign ids are 404', async () => {
    const f = await makeFamily(db);
    const other = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    await expect(removeMember(db, f.owner, f.owner.memberId, { eventsPolicy: 'keep' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(removeMember(db, mom, f.owner.memberId, { eventsPolicy: 'keep' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(removeMember(db, f.owner, other.owner.memberId, { eventsPolicy: 'keep' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(removeMember(db, f.owner, crypto.randomUUID(), { eventsPolicy: 'keep' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [o] = await db.select().from(members).where(eq(members.id, other.owner.memberId));
    expect(o!.removedAt).toBeNull();
  });
});

describe('invites', () => {
  it('stores only a hash and exposes only name+code publicly', async () => {
    const f = await makeFamily(db, { familyName: 'Invite Fam' });
    const inv = await createInvite(db, f.owner, {});
    const [row] = await db.select().from(invites).where(eq(invites.id, inv.id));
    expect(row!.tokenHash).toBe(hashToken(inv.token));
    expect(row!.tokenHash).not.toBe(inv.token);
    const info = await getJoinInfo(db, inv.token);
    expect(info).toEqual({ calendarName: 'Invite Fam', code: f.code });
  });

  it('expired, revoked and exhausted invites are not found', async () => {
    const f = await makeFamily(db);
    const expired = await createInvite(db, f.owner, {});
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.id));
    await expect(getJoinInfo(db, expired.token)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const revoked = await createInvite(db, f.owner, {});
    await revokeInvite(db, f.owner, revoked.id);
    await expect(getJoinInfo(db, revoked.token)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const single = await createInvite(db, f.owner, { maxUses: 1 });
    await joinCalendar(db, { code: f.code, memberName: 'One', password: PASSWORD, inviteToken: single.token }, { ip: randomIp() });
    await expect(getJoinInfo(db, single.token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(joinCalendar(db, { code: f.code, memberName: 'Two', password: PASSWORD, inviteToken: single.token }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.select().from(members).where(and(eq(members.calendarId, f.calendar.id), eq(members.nameKey, 'two')))).toHaveLength(0);
  });

  it('token never bypasses the password; uses increments once on success', async () => {
    const f = await makeFamily(db);
    const inv = await createInvite(db, f.owner, { maxUses: 5 });
    await expect(joinCalendar(db, { code: f.code, memberName: 'Mom', password: 'wrong-pass', inviteToken: inv.token }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    let [row] = await db.select().from(invites).where(eq(invites.id, inv.id));
    expect(row!.uses).toBe(0);
    const ok = await joinCalendar(db, { code: f.code, memberName: 'Mom', password: PASSWORD, inviteToken: inv.token }, { ip: randomIp() });
    expect(ok.status).toBe('joined');
    [row] = await db.select().from(invites).where(eq(invites.id, inv.id));
    expect(row!.uses).toBe(1);
  });

  it("an invite for calendar A cannot be used on calendar B", async () => {
    const a = await makeFamily(db);
    const b = await makeFamily(db);
    const inv = await createInvite(db, a.owner, {});
    await expect(joinCalendar(db, { code: b.code, memberName: 'Spy', password: PASSWORD, inviteToken: inv.token }, { ip: randomIp() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [row] = await db.select().from(invites).where(eq(invites.id, inv.id));
    expect(row!.uses).toBe(0);
  });

  it('members cannot manage invites; foreign invite ids are 404; owner can list and revoke', async () => {
    const f = await makeFamily(db);
    const other = await makeFamily(db);
    const mom = await joinAs(db, f.code, 'Mom');
    const inv = await createInvite(db, f.owner, { expiresInHours: 2 });
    const foreign = await createInvite(db, other.owner, {});
    await expect(createInvite(db, mom, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(listInvites(db, mom)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(revokeInvite(db, mom, inv.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(revokeInvite(db, f.owner, foreign.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const list = await listInvites(db, f.owner);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(inv.token);
    await revokeInvite(db, f.owner, inv.id);
    expect((await listInvites(db, f.owner))[0]!.revokedAt).not.toBeNull();
  });

  it('validates invite options', async () => {
    const f = await makeFamily(db);
    await expect(createInvite(db, f.owner, { expiresInHours: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createInvite(db, f.owner, { maxUses: 1000 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
