import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

const ORIGIN = 'http://localhost:3000';
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let createCal: { POST: Handler };
let eventsRoute: { GET: Handler; POST: Handler };
let eventRoute: { PATCH: Handler; DELETE: Handler };
let conflictsRoute: { GET: Handler };
let historyRoute: { GET: Handler };

beforeAll(async () => {
  const { url } = await createTestDb();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = ORIGIN;
  createCal = await import('@/app/api/calendars/route');
  eventsRoute = await import('@/app/api/events/route');
  eventRoute = await import('@/app/api/events/[id]/route');
  conflictsRoute = await import('@/app/api/conflicts/route');
  historyRoute = await import('@/app/api/events/[id]/history/route');
});
afterAll(stopTestServer);

const call = (h: Handler, path: string, o: { method?: string; body?: unknown; cookie?: string; params?: Record<string, string>; headers?: Record<string, string> } = {}) =>
  h(
    new Request(ORIGIN + path, {
      method: o.method ?? 'GET',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-requested-with': 'fetch', ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }),
    { params: Promise.resolve(o.params ?? {}) },
  );

async function family() {
  const res = await call(createCal.POST, '/api/calendars', { method: 'POST', body: { familyName: 'F', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' } });
  const body = await res.json();
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, memberId: body.member.id as string };
}

describe('events API', () => {
  it('creates (idempotently), lists, patches with versions, deletes', async () => {
    const f = await family();
    const body = { title: 'Gym', memberId: f.memberId, allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T19:30' };
    const hdr = { 'idempotency-key': 'abc-123' };
    const r1 = await call(eventsRoute.POST, '/api/events', { method: 'POST', body, cookie: f.cookie, headers: hdr });
    const r2 = await call(eventsRoute.POST, '/api/events', { method: 'POST', body, cookie: f.cookie, headers: hdr });
    expect(r1.status).toBe(201);
    const e1 = await r1.json();
    expect((await r2.json()).eventId).toBe(e1.eventId);

    const list = await call(eventsRoute.GET, '/api/events?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z', { cookie: f.cookie });
    const data = await list.json();
    expect(data.occurrences).toHaveLength(1);
    expect(data.dayStatus['2026-10-10']).toBe('scheduled');

    const bad = await call(eventRoute.PATCH, `/api/events/${e1.eventId}`, { method: 'PATCH', cookie: f.cookie, params: { id: e1.eventId }, body: { title: 'x', version: 9 } });
    expect(bad.status).toBe(409);
    const ok = await call(eventRoute.PATCH, `/api/events/${e1.eventId}`, { method: 'PATCH', cookie: f.cookie, params: { id: e1.eventId }, body: { title: 'Gym 2', version: 1 } });
    expect((await ok.json()).version).toBe(2);

    const hist = await call(historyRoute.GET, `/api/events/${e1.eventId}/history`, { cookie: f.cookie, params: { id: e1.eventId } });
    expect((await hist.json()).history).toHaveLength(2);

    const del = await call(eventRoute.DELETE, `/api/events/${e1.eventId}?version=2`, { method: 'DELETE', cookie: f.cookie, params: { id: e1.eventId } });
    expect(del.status).toBe(200);
  });

  it('rejects unauthenticated access, bad ranges and non-uuid ids', async () => {
    const f = await family();
    expect((await call(eventsRoute.GET, '/api/events?from=2026-10-10&to=2026-10-11')).status).toBe(401);
    expect((await call(eventsRoute.GET, '/api/events?from=2026-10-11&to=2026-10-10', { cookie: f.cookie })).status).toBe(400);
    expect((await call(eventsRoute.GET, '/api/events?from=2000-01-01&to=2026-10-10', { cookie: f.cookie })).status).toBe(400);
    expect((await call(eventsRoute.GET, '/api/events?from=garbage&to=2026-10-10', { cookie: f.cookie })).status).toBe(400);
    expect((await call(conflictsRoute.GET, '/api/conflicts?from=2026-10-10&to=2026-10-11', { cookie: f.cookie })).status).toBe(200);
    const res = await call(eventRoute.PATCH, '/api/events/not-a-uuid', { method: 'PATCH', cookie: f.cookie, params: { id: 'not-a-uuid' }, body: { version: 1 } });
    expect(res.status).toBe(404);
  });

  it('a foreign calendar cookie gets 404 for someone elses event', async () => {
    const a = await family(); const b = await family();
    const created = await (await call(eventsRoute.POST, '/api/events', {
      method: 'POST', cookie: a.cookie,
      body: { title: 'Private', memberId: a.memberId, allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T19:00' },
    })).json();
    const res = await call(eventRoute.PATCH, `/api/events/${created.eventId}`, { method: 'PATCH', cookie: b.cookie, params: { id: created.eventId }, body: { title: 'x', version: 1 } });
    expect(res.status).toBe(404);
    const del = await call(eventRoute.DELETE, `/api/events/${created.eventId}?version=1`, { method: 'DELETE', cookie: b.cookie, params: { id: created.eventId } });
    expect(del.status).toBe(404);
  });
});
