import { and, asc, eq } from 'drizzle-orm';
import type { DbLike } from '@/server/db/client';
import { eventAudit, members } from '@/server/db/schema';

export interface AuditInput {
  calendarId: string;
  eventId: string;
  action: 'create' | 'update' | 'delete' | 'restore';
  actorMemberId: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(tx: DbLike, a: AuditInput): Promise<void> {
  await tx.insert(eventAudit).values({
    calendarId: a.calendarId,
    eventId: a.eventId,
    action: a.action,
    actorMemberId: a.actorMemberId,
    before: a.before ?? null,
    after: a.after ?? null,
  });
}

export interface HistoryEntry {
  action: string;
  actorName: string;
  at: string;
  before: unknown;
  after: unknown;
}

/** Chronological audit trail for one event, scoped to the calendar. Names resolve even for removed members. */
export async function listHistory(tx: DbLike, calendarId: string, eventId: string): Promise<HistoryEntry[]> {
  const rows = await tx
    .select({ action: eventAudit.action, at: eventAudit.at, before: eventAudit.before, after: eventAudit.after, actorName: members.name })
    .from(eventAudit)
    .leftJoin(members, and(eq(members.id, eventAudit.actorMemberId), eq(members.calendarId, eventAudit.calendarId)))
    .where(and(eq(eventAudit.calendarId, calendarId), eq(eventAudit.eventId, eventId)))
    .orderBy(asc(eventAudit.at), asc(eventAudit.id));
  return rows.map((r) => ({
    action: r.action,
    actorName: r.actorName ?? 'Unknown',
    at: r.at.toISOString(),
    before: r.before,
    after: r.after,
  }));
}
