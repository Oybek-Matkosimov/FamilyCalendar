import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { calendars, invites } from '@/server/db/schema';
import { AppError } from '@/lib/errors';
import { createInviteSchema, parseOrThrow, type CreateInviteInput } from '@/lib/validation';
import { authorize, type Actor } from '@/server/authz/policy';
import { hashToken, newToken } from '@/server/auth/tokens';

export interface InviteSummary {
  id: string;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
}

export async function createInvite(db: Db, actor: Actor, input: CreateInviteInput) {
  authorize(actor, 'invite.manage');
  const opts = parseOrThrow(createInviteSchema, input);
  const token = newToken();
  const expiresAt = new Date(Date.now() + (opts.expiresInHours ?? 168) * 3600e3);
  const [row] = await db
    .insert(invites)
    .values({ calendarId: actor.calendarId, tokenHash: hashToken(token), createdBy: actor.memberId, expiresAt, maxUses: opts.maxUses ?? null })
    .returning();
  return { id: row!.id, token, expiresAt, maxUses: row!.maxUses };
}

export async function listInvites(db: Db, actor: Actor): Promise<InviteSummary[]> {
  authorize(actor, 'invite.manage');
  const rows = await db.select().from(invites).where(eq(invites.calendarId, actor.calendarId)).orderBy(desc(invites.createdAt));
  return rows.map((r) => ({
    id: r.id,
    expiresAt: r.expiresAt.toISOString(),
    maxUses: r.maxUses,
    uses: r.uses,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revokeInvite(db: Db, actor: Actor, inviteId: string): Promise<void> {
  authorize(actor, 'invite.manage');
  const rows = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, inviteId), eq(invites.calendarId, actor.calendarId)))
    .returning({ id: invites.id });
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Invite not found');
}

/** Public: lets the join page show which calendar an invite is for. Reveals nothing but name and code. */
export async function getJoinInfo(db: Db, token: string): Promise<{ calendarName: string; code: string }> {
  const [row] = await db
    .select({ name: calendars.name, code: calendars.code })
    .from(invites)
    .innerJoin(calendars, eq(calendars.id, invites.calendarId))
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.revokedAt),
        isNull(calendars.deletedAt),
        sql`${invites.expiresAt} > now()`,
        sql`(${invites.maxUses} is null or ${invites.uses} < ${invites.maxUses})`,
      ),
    )
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Invite not found or expired');
  return { calendarName: row.name, code: row.code };
}
