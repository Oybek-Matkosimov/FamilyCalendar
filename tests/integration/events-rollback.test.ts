import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily } from '../helpers/services';
import type { Db } from '@/server/db/client';
import { events } from '@/server/db/schema';

const state = { failAudit: false };
vi.mock('@/server/services/audit', async (orig) => {
  const actual = await orig<typeof import('@/server/services/audit')>();
  return {
    ...actual,
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      if (state.failAudit) throw new Error('audit unavailable');
      return actual.writeAudit(...args);
    },
  };
});

import { createEvent, updateEvent } from '@/server/services/events';

let db: Db; let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await setup()); });
afterAll(async () => { await close(); await stopTestServer(); });

describe('transactions', () => {
  it('a failing audit write rolls back event creation', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    state.failAudit = true;
    await expect(createEvent(db, f.owner, { title: 'X', memberId: f.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' }, 'rb-key'))
      .rejects.toThrow('audit unavailable');
    state.failAudit = false;
    expect(await db.select().from(events).where(eq(events.calendarId, f.calendar.id))).toHaveLength(0);
    // the idempotency key must not be left claimed by the failed attempt
    const ok = await createEvent(db, f.owner, { title: 'X', memberId: f.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' }, 'rb-key');
    expect(ok.title).toBe('X');
  });

  it('a failing audit write rolls back an update (version and fields unchanged)', async () => {
    const f = await makeFamily(db, { timezone: 'UTC' });
    const ev = await createEvent(db, f.owner, { title: 'Before', memberId: f.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' });
    state.failAudit = true;
    await expect(updateEvent(db, f.owner, ev.eventId, { title: 'After', version: 1, scope: 'series' })).rejects.toThrow('audit unavailable');
    state.failAudit = false;
    const [row] = await db.select().from(events).where(eq(events.id, ev.eventId));
    expect(row!.title).toBe('Before');
    expect(row!.version).toBe(1);
  });
});
