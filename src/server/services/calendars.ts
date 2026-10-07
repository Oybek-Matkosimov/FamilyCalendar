import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { calendars, members, invites } from '@/server/db/schema';
import { AppError } from '@/lib/errors';
import {
  cleanText, nameKey, parseOrThrow, passwordSchema, updateCalendarSchema,
  type CreateCalendarInput, type JoinInput, type UpdateCalendarInput,
} from '@/lib/validation';
import { hashPassword, verifyDummy, verifyPassword } from '@/server/auth/password';
import { hashToken, newCalendarCode, newRecoveryCode } from '@/server/auth/tokens';
import { assertNotLocked, clearFailures, recordFailure } from '@/server/auth/lockout';
import { createSession, revokeCalendarSessions } from '@/server/auth/session';
import { authorize, type Actor } from '@/server/authz/policy';

export interface MemberDTO { id: string; name: string; role: 'owner' | 'member'; color: string; lastActiveAt: string | null }
export interface CalendarDTO {
  id: string; code: string; name: string; timezone: string;
  settings: { membersCanEditAll: boolean }; createdAt: string; updatedAt: string;
}
export interface RequestCtx { ip: string; ua?: string }

const PALETTE = ['#2563eb', '#db2777', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4b5563'];
const GENERIC_AUTH = 'Invalid calendar ID or password';

export const toMemberDTO = (m: typeof members.$inferSelect): MemberDTO => ({
  id: m.id, name: m.name, role: m.role, color: m.color, lastActiveAt: m.lastActiveAt?.toISOString() ?? null,
});
export const toCalendarDTO = (c: typeof calendars.$inferSelect): CalendarDTO => ({
  id: c.id, code: c.code, name: c.name, timezone: c.timezone, settings: { membersCanEditAll: c.settings?.membersCanEditAll ?? true },
  createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
});

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function nextColor(tx: Tx | Db, calendarId: string): Promise<string> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.calendarId, calendarId));
  return PALETTE[(row?.n ?? 0) % PALETTE.length]!;
}

export async function createCalendar(db: Db, input: CreateCalendarInput, ctx: RequestCtx) {
  const createKey = `create:${ctx.ip}`;
  await assertNotLocked(db, [createKey]);
  const familyName = cleanText(input.familyName);
  const memberName = cleanText(input.memberName);
  const passwordHash = await hashPassword(input.password);
  const recoveryCode = newRecoveryCode();
  const recoveryHash = await hashPassword(recoveryCode);

  const { calendar, member } = await db.transaction(async (tx) => {
    let cal: typeof calendars.$inferSelect | undefined;
    for (let attempt = 0; attempt < 8 && !cal; attempt++) {
      [cal] = await tx
        .insert(calendars)
        .values({ code: newCalendarCode(), name: familyName, passwordHash, recoveryHash, timezone: input.timezone })
        .onConflictDoNothing({ target: calendars.code })
        .returning();
    }
    if (!cal) throw new AppError('UNAVAILABLE', 'Could not allocate a calendar ID. Please try again.');
    const [mem] = await tx
      .insert(members)
      .values({ calendarId: cal.id, name: memberName, nameKey: nameKey(memberName), role: 'owner', color: PALETTE[0]! })
      .returning();
    await tx.update(calendars).set({ ownerMemberId: mem!.id }).where(eq(calendars.id, cal.id));
    return { calendar: { ...cal, ownerMemberId: mem!.id }, member: mem! };
  });
  const session = await createSession(db, calendar.id, member.id, ctx.ua);
  await recordFailure(db, [createKey], { max: 10 }); // counts creations per IP
  return {
    calendar: toCalendarDTO(calendar), member: toMemberDTO(member), recoveryCode,
    sessionToken: session.token, sessionExpiresAt: session.expiresAt,
  };
}

export interface JoinResult {
  status: 'joined' | 'needs_confirmation';
  calendar?: CalendarDTO; member?: MemberDTO; sessionToken?: string; sessionExpiresAt?: Date;
}

export async function joinCalendar(db: Db, input: JoinInput, ctx: RequestCtx): Promise<JoinResult> {
  const calKey = `cal:${input.code}`;
  const keys = [calKey, `ip:${ctx.ip}`];
  await assertNotLocked(db, keys);

  const [cal] = await db.select().from(calendars).where(and(eq(calendars.code, input.code), isNull(calendars.deletedAt))).limit(1);
  if (!cal) {
    await verifyDummy(input.password);
    await recordFailure(db, keys);
    throw new AppError('UNAUTHENTICATED', GENERIC_AUTH);
  }
  if (!(await verifyPassword(cal.passwordHash, input.password))) {
    await recordFailure(db, keys);
    throw new AppError('UNAUTHENTICATED', GENERIC_AUTH);
  }
  await clearFailures(db, [calKey]);

  const name = cleanText(input.memberName);
  const key = nameKey(name);

  const outcome = await db.transaction(async (tx) => {
    if (input.inviteToken) {
      const used = await tx
        .update(invites)
        .set({ uses: sql`${invites.uses} + 1` })
        .where(and(
          eq(invites.tokenHash, hashToken(input.inviteToken)), eq(invites.calendarId, cal.id), isNull(invites.revokedAt),
          sql`${invites.expiresAt} > now()`, sql`(${invites.maxUses} is null or ${invites.uses} < ${invites.maxUses})`,
        ))
        .returning({ id: invites.id });
      if (used.length === 0) throw new AppError('NOT_FOUND', 'Invite not found or expired');
    }
    const findActive = () =>
      tx.select().from(members).where(and(eq(members.calendarId, cal.id), eq(members.nameKey, key), isNull(members.removedAt))).limit(1);
    let [existing] = await findActive();
    if (existing) return input.confirmExisting ? { member: existing } : { confirm: true as const };
    const [created] = await tx
      .insert(members)
      .values({ calendarId: cal.id, name, nameKey: key, role: 'member', color: await nextColor(tx, cal.id) })
      .onConflictDoNothing()
      .returning();
    if (created) return { member: created };
    // Lost a race with a concurrent join of the same name.
    [existing] = await findActive();
    if (!existing) throw new AppError('UNAVAILABLE', 'Could not join. Please try again.');
    return input.confirmExisting ? { member: existing } : { confirm: true as const };
  });

  if ('confirm' in outcome) return { status: 'needs_confirmation' };
  const session = await createSession(db, cal.id, outcome.member.id, ctx.ua);
  return {
    status: 'joined', calendar: toCalendarDTO(cal), member: toMemberDTO(outcome.member),
    sessionToken: session.token, sessionExpiresAt: session.expiresAt,
  };
}

export async function getCalendar(db: Db, actor: Actor): Promise<CalendarDTO & { me: MemberDTO }> {
  const [cal] = await db.select().from(calendars).where(and(eq(calendars.id, actor.calendarId), isNull(calendars.deletedAt))).limit(1);
  const [me] = await db.select().from(members).where(and(eq(members.id, actor.memberId), eq(members.calendarId, actor.calendarId))).limit(1);
  if (!cal || !me) throw new AppError('NOT_FOUND', 'Calendar not found');
  return { ...toCalendarDTO(cal), me: toMemberDTO(me) };
}

export async function updateCalendar(db: Db, actor: Actor, patch: UpdateCalendarInput): Promise<CalendarDTO> {
  authorize(actor, 'calendar.update');
  const p = parseOrThrow(updateCalendarSchema, patch);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(calendars).where(eq(calendars.id, actor.calendarId)).for('update');
    if (!cur) throw new AppError('NOT_FOUND', 'Calendar not found');
    const [row] = await tx
      .update(calendars)
      .set({
        name: p.name ?? cur.name,
        timezone: p.timezone ?? cur.timezone,
        settings: { membersCanEditAll: p.settings?.membersCanEditAll ?? cur.settings?.membersCanEditAll ?? true },
        updatedAt: new Date(),
      })
      .where(eq(calendars.id, actor.calendarId))
      .returning();
    return toCalendarDTO(row!);
  });
}

export async function changePassword(db: Db, actor: Actor, current: string, next: string, keepToken?: string): Promise<void> {
  authorize(actor, 'password.change');
  parseOrThrow(passwordSchema, next);
  const key = `pw:${actor.memberId}`;
  await assertNotLocked(db, [key]);
  const [cal] = await db.select().from(calendars).where(eq(calendars.id, actor.calendarId)).limit(1);
  if (!cal) throw new AppError('NOT_FOUND', 'Calendar not found');
  if (!(await verifyPassword(cal.passwordHash, current))) {
    await recordFailure(db, [key]);
    throw new AppError('FORBIDDEN', 'Current password is incorrect');
  }
  await clearFailures(db, [key]);
  const passwordHash = await hashPassword(next);
  await db.transaction(async (tx) => {
    await tx.update(calendars).set({ passwordHash, updatedAt: new Date() }).where(eq(calendars.id, actor.calendarId));
    await revokeCalendarSessions(tx as unknown as Db, actor.calendarId, keepToken);
  });
}

export async function recoverPassword(db: Db, code: string, recoveryCode: string, newPassword: string, ctx: RequestCtx) {
  parseOrThrow(passwordSchema, newPassword);
  const calKey = `rec:${code}`;
  const keys = [calKey, `ip:${ctx.ip}`];
  const fail = async (): Promise<never> => {
    await recordFailure(db, keys);
    throw new AppError('UNAUTHENTICATED', 'Invalid calendar ID or recovery code');
  };
  await assertNotLocked(db, keys);
  const [cal] = await db.select().from(calendars).where(and(eq(calendars.code, code), isNull(calendars.deletedAt))).limit(1);
  if (!cal) {
    await verifyDummy(recoveryCode);
    return fail();
  }
  if (!(await verifyPassword(cal.recoveryHash, recoveryCode.trim().toUpperCase()))) return fail();
  await clearFailures(db, [calKey]);

  const passwordHash = await hashPassword(newPassword);
  const nextRecovery = newRecoveryCode();
  const recoveryHash = await hashPassword(nextRecovery);
  await db.transaction(async (tx) => {
    await tx.update(calendars).set({ passwordHash, recoveryHash, updatedAt: new Date() }).where(eq(calendars.id, cal.id));
    await revokeCalendarSessions(tx as unknown as Db, cal.id);
  });
  return { recoveryCode: nextRecovery };
}

export async function deleteCalendar(db: Db, actor: Actor, confirmName: string): Promise<void> {
  authorize(actor, 'calendar.delete');
  const [cal] = await db.select().from(calendars).where(eq(calendars.id, actor.calendarId)).limit(1);
  if (!cal) throw new AppError('NOT_FOUND', 'Calendar not found');
  if (cleanText(confirmName) !== cal.name) throw new AppError('VALIDATION', 'Type the calendar name exactly to confirm deletion');
  await db.delete(calendars).where(eq(calendars.id, actor.calendarId));
}
