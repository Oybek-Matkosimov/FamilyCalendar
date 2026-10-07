import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { stopTestServer } from '../helpers/db';
import { setup, makeFamily, joinAs } from '../helpers/services';
import type { Db } from '@/server/db/client';
import { notifyChange } from '@/server/realtime/notify';
import { startHub, subscribe, type Change } from '@/server/realtime/hub';
import { onDomainEvent, emitDomainEvent } from '@/server/events-bus';
import { createEvent, updateEvent, deleteEvent } from '@/server/services/events';
import { removeMember } from '@/server/services/members';
import { updateCalendar, deleteCalendar } from '@/server/services/calendars';

let db: Db; let url: string; let close: () => Promise<void>;
let hub: { stop(): Promise<void> };
beforeAll(async () => {
  ({ db, url, close } = await setup());
  hub = await startHub(url);
});
afterAll(async () => { await hub.stop(); await close(); await stopTestServer(); });

const collect = (calendarId: string) => {
  const got: Change[] = [];
  const unsub = subscribe(calendarId, (c) => got.push(c));
  return { got, unsub };
};
const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('hub', () => {
  it('delivers only to subscribers of the same calendar and stops after unsubscribe', async () => {
    const a = collect('cal-a'); const b = collect('cal-b');
    await notifyChange(db, 'cal-a', { type: 'event', id: '1' });
    await until(() => a.got.length === 1);
    await settle();
    expect(a.got[0]).toEqual({ type: 'event', id: '1' });
    expect(b.got).toHaveLength(0);
    a.unsub();
    await notifyChange(db, 'cal-a', { type: 'event', id: '2' });
    await settle();
    expect(a.got).toHaveLength(1);
    b.unsub();
  });

  it('keeps delivering after its database connection is killed', async () => {
    const f = collect('cal-reconnect');
    const admin = postgres(url, { max: 1 });
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'fc-hub'`;
    await until(() => {
      void notifyChange(db, 'cal-reconnect', { type: 'event', id: 'after-kill' });
      return f.got.some((c) => c.id === 'after-kill');
    }, 20000);
    await admin.end();
    f.unsub();
  });
});

describe('services publish changes after commit', () => {
  it('event create, update and delete notify the calendar', async () => {
    const fam = await makeFamily(db, { timezone: 'UTC' });
    const c = collect(fam.calendar.id);
    const ev = await createEvent(db, fam.owner, { title: 'X', memberId: fam.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' });
    await until(() => c.got.length >= 1);
    expect(c.got[0]).toEqual({ type: 'event', id: ev.eventId });
    await updateEvent(db, fam.owner, ev.eventId, { title: 'Y', version: 1, scope: 'series' });
    await deleteEvent(db, fam.owner, ev.eventId, { version: 2, scope: 'series' });
    await until(() => c.got.length >= 3);
    c.unsub();
  });

  it('a failed mutation does not notify', async () => {
    const fam = await makeFamily(db, { timezone: 'UTC' });
    const c = collect(fam.calendar.id);
    await expect(createEvent(db, fam.owner, { title: 'X', memberId: fam.owner.memberId, allDay: false, start: '2026-10-10T11:00', end: '2026-10-10T10:00' })).rejects.toBeTruthy();
    await settle();
    expect(c.got).toHaveLength(0);
    c.unsub();
  });

  it('member, calendar and deletion changes notify', async () => {
    const fam = await makeFamily(db, { timezone: 'UTC' });
    const c = collect(fam.calendar.id);
    const mom = await joinAs(db, fam.code, 'Mom');
    await until(() => c.got.some((x) => x.type === 'member'));
    await removeMember(db, fam.owner, mom.memberId, { eventsPolicy: 'keep' });
    await updateCalendar(db, fam.owner, { name: 'Renamed' });
    await until(() => c.got.some((x) => x.type === 'calendar'));
    await deleteCalendar(db, fam.owner, 'Renamed');
    await until(() => c.got.some((x) => x.type === 'deleted'));
    c.unsub();
  });
});

describe('domain event bus', () => {
  it('delivers events and survives a throwing subscriber', () => {
    const seen: string[] = [];
    const off1 = onDomainEvent(() => { throw new Error('boom'); });
    const off2 = onDomainEvent((name) => seen.push(name));
    expect(() => emitDomainEvent('event.created', { calendarId: 'c', eventId: 'e' })).not.toThrow();
    expect(seen).toEqual(['event.created']);
    off1(); off2();
  });

  it('emits conflict.detected when a new event overlaps another', async () => {
    const fam = await makeFamily(db, { timezone: 'UTC' });
    const dad = await joinAs(db, fam.code, 'Dad');
    const names: string[] = [];
    const off = onDomainEvent((name, p) => { if (p.calendarId === fam.calendar.id) names.push(name); });
    await createEvent(db, fam.owner, { title: 'A', memberId: fam.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T12:00' });
    await createEvent(db, dad, { title: 'B', memberId: dad.memberId, allDay: false, start: '2026-10-10T11:00', end: '2026-10-10T13:00' });
    off();
    expect(names).toEqual(['event.created', 'event.created', 'conflict.detected']);
  });
});

describe('failure isolation', () => {
  it('a notification failure never fails the mutation', async () => {
    const fam = await makeFamily(db, { timezone: 'UTC' });
    const spy = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('notify down'));
    const ev = await createEvent(db, fam.owner, { title: 'Still saved', memberId: fam.owner.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' });
    spy.mockRestore();
    expect(ev.title).toBe('Still saved');
  });
});
