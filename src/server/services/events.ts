import { createHash } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { rrulestr } from 'rrule';
import { z } from 'zod';
import type { Db, DbLike } from '@/server/db/client';
import { calendars, events, idempotencyKeys, members } from '@/server/db/schema';
import { AppError } from '@/lib/errors';
import { dayBounds, dayKey } from '@/lib/time';
import {
  eventInputSchema, eventPatchSchema, parseOrThrow, rangeSchema,
  type EventInput, type EventPatch, type RecurrenceInput,
} from '@/lib/validation';
import {
  dayStatuses, findOverlaps, groupConflicts, type Occurrence,
} from '@/lib/conflicts';
import { buildRRule, expandSeries, type SeriesSource } from '@/lib/recurrence';
import { authorize, type Actor } from '@/server/authz/policy';
import { listHistory, writeAudit, type HistoryEntry } from './audit';
import { buildConflictDTOs, type ConflictDTO, type MemberName } from './conflicts';
import { emitDomainEvent, type DomainEventName } from '@/server/events-bus';
import { publishChange } from '@/server/realtime/notify';
import { logger } from '@/server/logger';

type EventRow = typeof events.$inferSelect;

export interface OccurrenceDTO {
  eventId: string;
  memberId: string;
  memberName: string;
  memberRemoved: boolean;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  occurrenceDate: string;
  isRecurring: boolean;
  seriesId: string | null;
  version: number;
  createdBy: { id: string; name: string };
  createdAt: string;
  updatedBy: { id: string; name: string };
  updatedAt: string;
  recurrence: RecurrenceInput | null;
}

const LOCAL_FMT = "yyyy-MM-dd'T'HH:mm";
const MAX_DURATION_MS = 7 * 86400000;
const MAX_OCCURRENCES = 2000;
const STALE_MESSAGE = 'This event was changed by someone else. Review the latest version.';

const normLocal = (s: string): string => s.replace(' ', 'T').slice(0, 16);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- helpers ----------

async function loadCalendar(tx: DbLike, calendarId: string) {
  const [c] = await tx
    .select({ timezone: calendars.timezone, settings: calendars.settings })
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), isNull(calendars.deletedAt)))
    .limit(1);
  if (!c) throw new AppError('NOT_FOUND', 'Calendar not found');
  return { timezone: c.timezone, settings: { membersCanEditAll: c.settings?.membersCanEditAll ?? true } };
}

async function loadNames(tx: DbLike, calendarId: string): Promise<Map<string, MemberName>> {
  const rows = await tx
    .select({ id: members.id, name: members.name, removedAt: members.removedAt })
    .from(members)
    .where(eq(members.calendarId, calendarId));
  return new Map(rows.map((r) => [r.id, { name: r.name, removed: r.removedAt !== null }]));
}

async function assertActiveMember(tx: DbLike, calendarId: string, memberId: string): Promise<void> {
  const [m] = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.calendarId, calendarId), isNull(members.removedAt)))
    .limit(1);
  if (!m) throw new AppError('VALIDATION', 'Unknown family member');
}

interface Times { startUtc: Date; endUtc: Date; localStart: string; localEnd: string }

function computeTimes(startStr: string, endStr: string, allDay: boolean, tz: string): Times {
  let s = DateTime.fromISO(startStr, { zone: tz });
  let e = DateTime.fromISO(endStr, { zone: tz });
  if (!s.isValid || !e.isValid) throw new AppError('VALIDATION', 'Invalid date or time');
  if (allDay) {
    s = s.startOf('day');
    e = e.startOf('day');
    if (e <= s) e = s.plus({ days: 1 });
  }
  if (e <= s) throw new AppError('VALIDATION', 'End must be after start');
  if (e.toMillis() - s.toMillis() > MAX_DURATION_MS) throw new AppError('VALIDATION', 'Events can be at most 7 days long');
  return {
    startUtc: s.toUTC().toJSDate(),
    endUtc: e.toUTC().toJSDate(),
    localStart: s.toFormat(LOCAL_FMT),
    localEnd: e.toFormat(LOCAL_FMT),
  };
}

function recurrenceFields(rec: RecurrenceInput | null | undefined, tz: string) {
  if (!rec) return { rrule: null, recurrence: null, recurUntil: null as Date | null };
  const rrule = buildRRule(rec);
  try {
    rrulestr(`DTSTART:20260101T000000Z\nRRULE:${rrule}`);
  } catch {
    throw new AppError('VALIDATION', 'Invalid repeat rule');
  }
  const recurUntil = rec.until ? DateTime.fromISO(rec.until, { zone: tz }).endOf('day').toJSDate() : null;
  return { rrule, recurrence: rec, recurUntil };
}

function seriesSource(row: EventRow): SeriesSource {
  return {
    id: row.id, memberId: row.memberId, title: row.title, allDay: row.allDay, tz: row.tz,
    localStart: normLocal(row.localStart!), localEnd: normLocal(row.localEnd!),
    rrule: row.rrule!, exceptions: row.exceptions ?? [], recurUntil: row.recurUntil,
  };
}

function snapshot(r: EventRow) {
  return {
    title: r.title, memberId: r.memberId, description: r.description, location: r.location, allDay: r.allDay,
    start: r.localStart ? normLocal(r.localStart) : null, end: r.localEnd ? normLocal(r.localEnd) : null,
    tz: r.tz, recurrence: r.recurrence, exceptions: r.exceptions,
  };
}

function toDTO(
  row: EventRow, occ: { start: Date; end: Date; occurrenceDate: string }, names: Map<string, MemberName>,
): OccurrenceDTO {
  const who = (id: string) => ({ id, name: names.get(id)?.name ?? 'Unknown' });
  return {
    eventId: row.id,
    memberId: row.memberId,
    memberName: names.get(row.memberId)?.name ?? 'Unknown',
    memberRemoved: names.get(row.memberId)?.removed ?? false,
    title: row.title,
    description: row.description,
    location: row.location,
    start: occ.start.toISOString(),
    end: occ.end.toISOString(),
    allDay: row.allDay,
    occurrenceDate: occ.occurrenceDate,
    isRecurring: row.rrule !== null,
    seriesId: row.seriesId,
    version: row.version,
    createdBy: who(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    updatedBy: who(row.updatedBy),
    updatedAt: row.updatedAt.toISOString(),
    recurrence: row.recurrence ?? null,
  };
}

const firstOccurrence = (row: EventRow) => ({ start: row.startUtc, end: row.endUtc, occurrenceDate: dayKey(row.startUtc, row.tz) });

async function dtoFor(tx: DbLike, row: EventRow): Promise<OccurrenceDTO> {
  return toDTO(row, firstOccurrence(row), await loadNames(tx, row.calendarId));
}

async function lockEvent(tx: DbLike, calendarId: string, id: string, opts: { deleted?: boolean } = {}): Promise<EventRow> {
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.calendarId, calendarId), opts.deleted ? isNotNull(events.deletedAt) : isNull(events.deletedAt)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', 'Event not found');
  return row;
}

function assertVersion(row: EventRow, version: number) {
  if (row.version !== version) throw new AppError('CONFLICT', STALE_MESSAGE, { current: row.version });
}

function assertOccurrence(row: EventRow, date: string | undefined) {
  if (!date) throw new AppError('VALIDATION', 'occurrenceDate is required for this occurrence');
  const { start, end } = dayBounds(date, row.tz);
  const hit = expandSeries(seriesSource(row), start, end, 50).some((o) => o.occurrenceDate === date);
  if (!hit) throw new AppError('VALIDATION', 'No occurrence of this event on that date');
}

// ---------- post-commit side effects ----------

/** Runs after the transaction committed; never throws (notifications must not fail a saved change). */
async function afterWrite(db: Db, calendarId: string, dto: OccurrenceDTO, name: DomainEventName): Promise<void> {
  try {
    emitDomainEvent(name, { calendarId, eventId: dto.eventId });
    await publishChange(db, calendarId, { type: 'event', id: dto.eventId });
    const from = dto.isRecurring ? new Date() : new Date(dto.start);
    const to = dto.isRecurring ? new Date(from.getTime() + 60 * 86400000) : new Date(dto.end);
    const { groups } = await loadRange(db, calendarId, from, to);
    if (groups.some((g) => g.occurrences.some((o) => o.eventId === dto.eventId))) {
      emitDomainEvent('conflict.detected', { calendarId, eventId: dto.eventId });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'post-commit event side effects failed');
  }
}

async function afterDelete(db: Db, calendarId: string, eventId: string): Promise<void> {
  emitDomainEvent('event.deleted', { calendarId, eventId });
  await publishChange(db, calendarId, { type: 'event', id: eventId });
}

// ---------- create ----------

export async function createEvent(db: Db, actor: Actor, rawInput: EventInput, idempotencyKey?: string): Promise<OccurrenceDTO> {
  authorize(actor, 'event.create');
  const input = parseOrThrow(eventInputSchema, rawInput);
  const key = idempotencyKey === undefined ? undefined : parseOrThrow(z.string().min(1).max(100), idempotencyKey);
  const requestHash = sha256(JSON.stringify(input));

  const { dto: created, replay } = await db.transaction(async (tx) => {
    if (key) {
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({ key, calendarId: actor.calendarId, memberId: actor.memberId, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (claimed.length === 0) {
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.calendarId, actor.calendarId)));
        if (!existing || existing.requestHash !== requestHash) {
          throw new AppError('CONFLICT', 'Idempotency key reuse with different data');
        }
        if (existing.response) return { dto: existing.response as OccurrenceDTO, replay: true };
        throw new AppError('CONFLICT', 'This request is already being processed');
      }
      if (Math.random() < 0.01) {
        await tx.delete(idempotencyKeys).where(sql`${idempotencyKeys.createdAt} < now() - interval '24 hours'`);
      }
    }

    const cal = await loadCalendar(tx, actor.calendarId);
    await assertActiveMember(tx, actor.calendarId, input.memberId);
    const times = computeTimes(input.start, input.end, input.allDay, cal.timezone);
    const rec = recurrenceFields(input.recurrence, cal.timezone);

    const [row] = await tx
      .insert(events)
      .values({
        calendarId: actor.calendarId, memberId: input.memberId, title: input.title,
        description: input.description || null, location: input.location || null,
        allDay: input.allDay, tz: cal.timezone, ...times, ...rec,
        createdBy: actor.memberId, updatedBy: actor.memberId,
      })
      .returning();
    await writeAudit(tx, { calendarId: actor.calendarId, eventId: row!.id, action: 'create', actorMemberId: actor.memberId, after: snapshot(row!) });
    const dto = await dtoFor(tx, row!);
    if (key) {
      await tx
        .update(idempotencyKeys)
        .set({ response: dto })
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.calendarId, actor.calendarId)));
    }
    return { dto, replay: false };
  });
  if (!replay) await afterWrite(db, actor.calendarId, created, 'event.created');
  return created;
}

// ---------- update ----------

export async function updateEvent(db: Db, actor: Actor, id: string, rawPatch: EventPatch): Promise<OccurrenceDTO> {
  const patch = parseOrThrow(eventPatchSchema, rawPatch);
  const result = await db.transaction(async (tx) => {
    const cal = await loadCalendar(tx, actor.calendarId);
    const row = await lockEvent(tx, actor.calendarId, id);
    authorize(actor, 'event.update', { settings: cal.settings, event: row });
    assertVersion(row, patch.version);

    const pick = <T>(next: T | undefined, cur: T): T => (next !== undefined ? next : cur);
    const memberId = pick(patch.memberId, row.memberId);
    if (memberId !== row.memberId) await assertActiveMember(tx, actor.calendarId, memberId);

    // --- edit only this occurrence of a series: skip the date on the series, create a linked one-off ---
    if (patch.scope === 'this' && row.rrule) {
      assertOccurrence(row, patch.occurrenceDate);
      const date = patch.occurrenceDate!;
      const curStart = DateTime.fromISO(normLocal(row.localStart!), { zone: 'utc' });
      const minutes = DateTime.fromISO(normLocal(row.localEnd!), { zone: 'utc' }).diff(curStart, 'minutes').minutes;
      const occStart = DateTime.fromISO(`${date}T${curStart.toFormat('HH:mm')}`, { zone: 'utc' });
      const allDay = pick(patch.allDay, row.allDay);
      const times = computeTimes(
        pick(patch.start, occStart.toFormat(LOCAL_FMT)),
        pick(patch.end, occStart.plus({ minutes }).toFormat(LOCAL_FMT)),
        allDay, cal.timezone,
      );
      const [one] = await tx
        .insert(events)
        .values({
          calendarId: actor.calendarId, memberId, title: pick(patch.title, row.title),
          description: (patch.description !== undefined ? patch.description : row.description) || null,
          location: (patch.location !== undefined ? patch.location : row.location) || null,
          allDay, tz: cal.timezone, ...times, seriesId: row.id, recurrenceDate: date,
          createdBy: actor.memberId, updatedBy: actor.memberId,
        })
        .returning();
      await writeAudit(tx, { calendarId: actor.calendarId, eventId: one!.id, action: 'create', actorMemberId: actor.memberId, after: snapshot(one!) });
      const [parent] = await tx
        .update(events)
        .set({
          exceptions: [...(row.exceptions ?? []), date], version: sql`${events.version} + 1`,
          updatedBy: actor.memberId, updatedAt: new Date(),
        })
        .where(and(eq(events.id, row.id), eq(events.calendarId, actor.calendarId)))
        .returning();
      await writeAudit(tx, {
        calendarId: actor.calendarId, eventId: row.id, action: 'update', actorMemberId: actor.memberId,
        before: { exceptions: row.exceptions }, after: { exceptions: parent!.exceptions },
      });
      return dtoFor(tx, one!);
    }

    // --- edit the event / whole series ---
    const timesChanged = patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined;
    const allDay = pick(patch.allDay, row.allDay);
    const times = timesChanged
      ? computeTimes(
          pick(patch.start, normLocal(row.localStart!)), pick(patch.end, normLocal(row.localEnd!)), allDay, cal.timezone,
        )
      : null;
    const tz = timesChanged ? cal.timezone : row.tz;
    const recChanged = patch.recurrence !== undefined;
    const rec = recChanged ? recurrenceFields(patch.recurrence, tz) : null;

    const [updated] = await tx
      .update(events)
      .set({
        memberId, title: pick(patch.title, row.title), allDay, tz,
        description: (patch.description !== undefined ? patch.description : row.description) || null,
        location: (patch.location !== undefined ? patch.location : row.location) || null,
        ...(times ?? {}), ...(rec ?? {}),
        version: sql`${events.version} + 1`, updatedBy: actor.memberId, updatedAt: new Date(),
      })
      .where(and(eq(events.id, row.id), eq(events.calendarId, actor.calendarId)))
      .returning();
    await writeAudit(tx, {
      calendarId: actor.calendarId, eventId: row.id, action: 'update', actorMemberId: actor.memberId,
      before: snapshot(row), after: snapshot(updated!),
    });
    return dtoFor(tx, updated!);
  });
  await afterWrite(db, actor.calendarId, result, 'event.updated');
  return result;
}

// ---------- delete / restore ----------

export async function deleteEvent(
  db: Db, actor: Actor, id: string, opts: { version: number; scope?: 'this' | 'series'; occurrenceDate?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const cal = await loadCalendar(tx, actor.calendarId);
    const row = await lockEvent(tx, actor.calendarId, id);
    authorize(actor, 'event.delete', { settings: cal.settings, event: row });
    assertVersion(row, opts.version);

    if (opts.scope === 'this' && row.rrule) {
      assertOccurrence(row, opts.occurrenceDate);
      const [parent] = await tx
        .update(events)
        .set({
          exceptions: [...(row.exceptions ?? []), opts.occurrenceDate!], version: sql`${events.version} + 1`,
          updatedBy: actor.memberId, updatedAt: new Date(),
        })
        .where(and(eq(events.id, row.id), eq(events.calendarId, actor.calendarId)))
        .returning();
      await writeAudit(tx, {
        calendarId: actor.calendarId, eventId: row.id, action: 'update', actorMemberId: actor.memberId,
        before: { exceptions: row.exceptions }, after: { exceptions: parent!.exceptions },
      });
      return;
    }
    await tx
      .update(events)
      .set({ deletedAt: new Date(), version: sql`${events.version} + 1`, updatedBy: actor.memberId, updatedAt: new Date() })
      .where(and(eq(events.id, row.id), eq(events.calendarId, actor.calendarId)));
    await writeAudit(tx, { calendarId: actor.calendarId, eventId: row.id, action: 'delete', actorMemberId: actor.memberId, before: snapshot(row) });
  });
  await afterDelete(db, actor.calendarId, id);
}

export async function restoreEvent(db: Db, actor: Actor, id: string): Promise<OccurrenceDTO> {
  authorize(actor, 'event.restore');
  const result = await db.transaction(async (tx) => {
    const row = await lockEvent(tx, actor.calendarId, id, { deleted: true });
    const [restored] = await tx
      .update(events)
      .set({ deletedAt: null, version: sql`${events.version} + 1`, updatedBy: actor.memberId, updatedAt: new Date() })
      .where(and(eq(events.id, row.id), eq(events.calendarId, actor.calendarId)))
      .returning();
    await writeAudit(tx, { calendarId: actor.calendarId, eventId: row.id, action: 'restore', actorMemberId: actor.memberId, after: snapshot(restored!) });
    return dtoFor(tx, restored!);
  });
  await afterWrite(db, actor.calendarId, result, 'event.updated');
  return result;
}

// ---------- reading ----------

interface RangeItem { row: EventRow; start: Date; end: Date; occurrenceDate: string }

async function loadRange(db: Db, calendarId: string, from: Date, to: Date) {
  const cal = await loadCalendar(db, calendarId);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.calendarId, calendarId),
        isNull(events.deletedAt),
        or(
          and(isNull(events.rrule), lt(events.startUtc, to), gt(events.endUtc, from)),
          and(isNotNull(events.rrule), lt(events.startUtc, to), or(isNull(events.recurUntil), gt(events.recurUntil, from))),
        ),
      ),
    );
  const items: RangeItem[] = [];
  for (const row of rows) {
    if (row.rrule) {
      for (const o of expandSeries(seriesSource(row), from, to, MAX_OCCURRENCES - items.length)) {
        items.push({ row, start: o.start, end: o.end, occurrenceDate: o.occurrenceDate });
      }
    } else {
      items.push({ row, start: row.startUtc, end: row.endUtc, occurrenceDate: dayKey(row.startUtc, cal.timezone) });
    }
    if (items.length >= MAX_OCCURRENCES) break;
  }
  const occurrences: Occurrence[] = items.map((i) => ({
    eventId: i.row.id, memberId: i.row.memberId, title: i.row.title, start: i.start, end: i.end,
    allDay: i.row.allDay, occurrenceDate: i.occurrenceDate,
  }));
  const groups = groupConflicts(findOverlaps(occurrences), cal.timezone);
  return { tz: cal.timezone, items, groups, dayStatus: dayStatuses(occurrences, groups, cal.timezone) };
}

export async function listEvents(
  db: Db, actor: Actor, q: { from: Date; to: Date; memberId?: string; search?: string },
): Promise<{ occurrences: OccurrenceDTO[]; dayStatus: Record<string, 'scheduled' | 'conflict'>; conflicts: ConflictDTO[] }> {
  const range = parseOrThrow(rangeSchema, { from: q.from, to: q.to });
  const { items, groups, dayStatus, tz } = await loadRange(db, actor.calendarId, range.from, range.to);
  const names = await loadNames(db, actor.calendarId);
  const needle = q.search?.trim().toLowerCase();
  // Conflicts and day status are family-wide truths; filters only narrow the listed occurrences.
  const occurrences = items
    .filter((i) => !q.memberId || i.row.memberId === q.memberId)
    .filter((i) => !needle || i.row.title.toLowerCase().includes(needle) || (i.row.description ?? '').toLowerCase().includes(needle))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.row.title.localeCompare(b.row.title))
    .map((i) => toDTO(i.row, i, names));
  return { occurrences, dayStatus, conflicts: buildConflictDTOs(groups, names, tz) };
}

export async function getConflicts(db: Db, actor: Actor, from: Date, to: Date) {
  const range = parseOrThrow(rangeSchema, { from, to });
  const { groups, dayStatus, tz } = await loadRange(db, actor.calendarId, range.from, range.to);
  return { conflicts: buildConflictDTOs(groups, await loadNames(db, actor.calendarId), tz), dayStatus };
}

export async function getEventHistory(db: Db, actor: Actor, id: string): Promise<HistoryEntry[]> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, id), eq(events.calendarId, actor.calendarId)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Event not found');
  return listHistory(db, actor.calendarId, id);
}
