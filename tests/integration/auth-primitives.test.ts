import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';
import { createDb, type Db } from '@/server/db/client';
import { calendars, members, sessions } from '@/server/db/schema';
import { hashPassword, verifyPassword } from '@/server/auth/password';
import { newToken, hashToken, newCalendarCode, newRecoveryCode } from '@/server/auth/tokens';
import { assertNotLocked, recordFailure, clearFailures } from '@/server/auth/lockout';
import { createSession, resolveSession, revokeSession, revokeMemberSessions } from '@/server/auth/session';
import { AppError } from '@/lib/errors';

let db: Db; let close: () => Promise<void>;
beforeAll(async () => {
  const { url } = await createTestDb();
  await runMigrations(url);
  const c = createDb(url, 4);
  db = c.db; close = () => c.sql.end();
});
afterAll(async () => { await close(); await stopTestServer(); });

let n = 100;
async function seed() {
  const [cal] = await db.insert(calendars).values({ code: `TEST-${n++}`, name: 'F', passwordHash: 'h', recoveryHash: 'r', timezone: 'UTC' }).returning();
  const [mem] = await db.insert(members).values({ calendarId: cal!.id, name: 'Mom', nameKey: 'mom', role: 'owner', color: '#000' }).returning();
  return { cal: cal!, mem: mem! };
}

describe('password + tokens', () => {
  it('hashes with argon2id, salts, and verifies', async () => {
    const h1 = await hashPassword('correct horse'); const h2 = await hashPassword('correct horse');
    expect(h1.startsWith('$argon2id$')).toBe(true);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword(h1, 'correct horse')).toBe(true);
    expect(await verifyPassword(h1, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
  it('generates well-formed tokens and codes', () => {
    expect(newToken().length).toBeGreaterThanOrEqual(43);
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(newCalendarCode()).toMatch(/^[A-HJ-NP-Z]{4}-\d{4}$/);
    expect(newRecoveryCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('lockout', () => {
  it('locks on the 5th failure, keys are independent, clearing resets', async () => {
    const keys = ['cal:LOCK-1', 'ip:1.1.1.1'];
    for (let i = 0; i < 4; i++) await recordFailure(db, keys);
    await expect(assertNotLocked(db, keys)).resolves.toBeUndefined();
    await recordFailure(db, keys);
    await expect(assertNotLocked(db, keys)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(assertNotLocked(db, ['cal:OTHER-1'])).resolves.toBeUndefined();
    await clearFailures(db, keys);
    await expect(assertNotLocked(db, keys)).resolves.toBeUndefined();
  });
  it('lock expires with time', async () => {
    const keys = ['cal:LOCK-2'];
    for (let i = 0; i < 5; i++) await recordFailure(db, keys);
    await expect(assertNotLocked(db, keys)).rejects.toBeInstanceOf(AppError);
    await db.execute(sql`update auth_attempts set locked_until = now() - interval '1 second' where key = 'cal:LOCK-2'`);
    await expect(assertNotLocked(db, keys)).resolves.toBeUndefined();
  });
  it('counts concurrent failures atomically', async () => {
    const keys = ['cal:LOCK-3'];
    await Promise.all(Array.from({ length: 5 }, () => recordFailure(db, keys)));
    await expect(assertNotLocked(db, keys)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('honors a higher max', async () => {
    const keys = ['create:9.9.9.9'];
    for (let i = 0; i < 9; i++) await recordFailure(db, keys, { max: 10 });
    await expect(assertNotLocked(db, keys)).resolves.toBeUndefined();
    await recordFailure(db, keys, { max: 10 });
    await expect(assertNotLocked(db, keys)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('sessions', () => {
  it('creates, resolves and stores only the hash', async () => {
    const { cal, mem } = await seed();
    const { token } = await createSession(db, cal.id, mem.id, 'jest');
    expect(await resolveSession(db, token)).toEqual({ calendarId: cal.id, memberId: mem.id, role: 'owner' });
    const [row] = await db.select().from(sessions).where(eq(sessions.memberId, mem.id));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toBe(token);
  });
  it('rejects unknown, expired, revoked sessions', async () => {
    const { cal, mem } = await seed();
    expect(await resolveSession(db, 'nope')).toBeNull();
    const a = await createSession(db, cal.id, mem.id);
    await db.execute(sql`update sessions set expires_at = now() - interval '1 second' where token_hash = ${hashToken(a.token)}`);
    expect(await resolveSession(db, a.token)).toBeNull();
    const b = await createSession(db, cal.id, mem.id);
    await revokeSession(db, b.token);
    expect(await resolveSession(db, b.token)).toBeNull();
  });
  it('stops working when the member is removed, the calendar deleted, or sessions revoked', async () => {
    const s1 = await seed(); const t1 = await createSession(db, s1.cal.id, s1.mem.id);
    await db.update(members).set({ removedAt: new Date() }).where(eq(members.id, s1.mem.id));
    expect(await resolveSession(db, t1.token)).toBeNull();
    const s2 = await seed(); const t2 = await createSession(db, s2.cal.id, s2.mem.id);
    await db.update(calendars).set({ deletedAt: new Date() }).where(eq(calendars.id, s2.cal.id));
    expect(await resolveSession(db, t2.token)).toBeNull();
    const s3 = await seed(); const t3 = await createSession(db, s3.cal.id, s3.mem.id);
    await revokeMemberSessions(db, s3.mem.id);
    expect(await resolveSession(db, t3.token)).toBeNull();
  });
});
