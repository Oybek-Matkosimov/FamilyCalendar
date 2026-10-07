import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { calendars, members, sessions } from '@/server/db/schema';
import type { Actor } from '@/server/authz/policy';
import { hashToken, newToken } from './tokens';

const SESSION_DAYS = 30;

export async function createSession(db: Db, calendarId: string, memberId: string, userAgent?: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.insert(sessions).values({ tokenHash: hashToken(token), calendarId, memberId, expiresAt, userAgent: userAgent?.slice(0, 300) });
  return { token, expiresAt };
}

/** Returns the actor for a valid session, or null. Slides expiry and touches last_active_at (at most once a minute). */
export async function resolveSession(db: Db, token: string): Promise<Actor | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id, calendarId: sessions.calendarId, memberId: sessions.memberId, role: members.role,
      expiresAt: sessions.expiresAt, lastActiveAt: members.lastActiveAt,
    })
    .from(sessions)
    .innerJoin(members, and(eq(members.id, sessions.memberId), eq(members.calendarId, sessions.calendarId)))
    .innerJoin(calendars, eq(calendars.id, sessions.calendarId))
    .where(and(
      eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`,
      isNull(members.removedAt), isNull(calendars.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() < now + (SESSION_DAYS - 1) * 86400000) {
    await db.update(sessions).set({ expiresAt: new Date(now + SESSION_DAYS * 86400000) }).where(eq(sessions.id, row.sessionId));
  }
  if (!row.lastActiveAt || now - row.lastActiveAt.getTime() > 60000) {
    await db.update(members).set({ lastActiveAt: new Date(now) }).where(eq(members.id, row.memberId));
  }
  return { calendarId: row.calendarId, memberId: row.memberId, role: row.role };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeMemberSessions(db: Db, memberId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.memberId, memberId), isNull(sessions.revokedAt)));
}

export async function revokeCalendarSessions(db: Db, calendarId: string, exceptToken?: string): Promise<void> {
  const cond = and(
    eq(sessions.calendarId, calendarId),
    isNull(sessions.revokedAt),
    exceptToken ? sql`${sessions.tokenHash} <> ${hashToken(exceptToken)}` : undefined,
  );
  await db.update(sessions).set({ revokedAt: new Date() }).where(cond);
}
