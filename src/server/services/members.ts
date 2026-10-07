import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { events, members } from '@/server/db/schema';
import { AppError } from '@/lib/errors';
import { authorize, type Actor } from '@/server/authz/policy';
import { revokeMemberSessions } from '@/server/auth/session';
import { publishChange } from '@/server/realtime/notify';
import { writeAudit } from './audit';
import { toMemberDTO, type MemberDTO } from './calendars';

export type EventsPolicy = 'keep' | 'delete' | { reassignTo: string };

export async function listMembers(db: Db, actor: Actor): Promise<MemberDTO[]> {
  const rows = await db
    .select()
    .from(members)
    .where(and(eq(members.calendarId, actor.calendarId), isNull(members.removedAt)))
    .orderBy(asc(members.createdAt));
  return rows.map(toMemberDTO);
}

export async function removeMember(db: Db, actor: Actor, memberId: string, opts: { eventsPolicy: EventsPolicy }): Promise<void> {
  authorize(actor, 'member.remove');
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(members)
      .where(and(eq(members.id, memberId), eq(members.calendarId, actor.calendarId), isNull(members.removedAt)))
      .for('update');
    if (!target) throw new AppError('NOT_FOUND', 'Member not found');
    if (target.role === 'owner') throw new AppError('VALIDATION', 'The owner cannot be removed');

    const policy = opts.eventsPolicy;
    const owned = await tx
      .select()
      .from(events)
      .where(and(eq(events.calendarId, actor.calendarId), eq(events.memberId, memberId), isNull(events.deletedAt)));

    if (policy === 'delete') {
      for (const ev of owned) {
        await tx
          .update(events)
          .set({ deletedAt: new Date(), version: sql`${events.version} + 1`, updatedBy: actor.memberId, updatedAt: new Date() })
          .where(and(eq(events.id, ev.id), eq(events.calendarId, actor.calendarId)));
        await writeAudit(tx, {
          calendarId: actor.calendarId, eventId: ev.id, action: 'delete', actorMemberId: actor.memberId,
          before: { title: ev.title, memberId: ev.memberId }, after: null,
        });
      }
    } else if (typeof policy === 'object') {
      if (policy.reassignTo === memberId) throw new AppError('VALIDATION', 'Choose a different member to reassign events to');
      const [dest] = await tx
        .select()
        .from(members)
        .where(and(eq(members.id, policy.reassignTo), eq(members.calendarId, actor.calendarId)));
      if (!dest) throw new AppError('NOT_FOUND', 'Member to reassign events to was not found');
      if (dest.removedAt) throw new AppError('VALIDATION', 'Cannot reassign events to a removed member');
      for (const ev of owned) {
        await tx
          .update(events)
          .set({ memberId: dest.id, version: sql`${events.version} + 1`, updatedBy: actor.memberId, updatedAt: new Date() })
          .where(and(eq(events.id, ev.id), eq(events.calendarId, actor.calendarId)));
        await writeAudit(tx, {
          calendarId: actor.calendarId, eventId: ev.id, action: 'update', actorMemberId: actor.memberId,
          before: { memberId: ev.memberId }, after: { memberId: dest.id },
        });
      }
    }

    await tx.update(members).set({ removedAt: new Date() }).where(eq(members.id, memberId));
    await revokeMemberSessions(tx as unknown as Db, memberId);
  });
  await publishChange(db, actor.calendarId, { type: 'member' });
  if (opts.eventsPolicy !== 'keep') await publishChange(db, actor.calendarId, { type: 'event' });
}
