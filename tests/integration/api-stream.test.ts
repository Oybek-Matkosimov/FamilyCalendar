import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

const ORIGIN = 'http://localhost:3000';
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let createCal: { POST: Handler };
let join: { POST: Handler };
let eventsRoute: { POST: Handler };
let stream: { GET: (req: Request) => Promise<Response> };
let memberRoute: { DELETE: Handler };
let hub: typeof import('@/server/realtime/hub');

beforeAll(async () => {
  const { url } = await createTestDb();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = ORIGIN;
  createCal = await import('@/app/api/calendars/route');
  join = await import('@/app/api/auth/join/route');
  eventsRoute = await import('@/app/api/events/route');
  stream = await import('@/app/api/stream/route');
  memberRoute = await import('@/app/api/members/[id]/route');
  hub = await import('@/server/realtime/hub');
});
afterAll(async () => {
  await (await hub.ensureHub().catch(() => null))?.stop();
  await stopTestServer();
});

const post = (h: Handler, path: string, body: unknown, cookie?: string, params: Record<string, string> = {}, method = 'POST') =>
  h(new Request(ORIGIN + path, {
    method, body: method === 'DELETE' ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}) },
  }), { params: Promise.resolve(params) });

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms = 8000): Promise<string> {
  const dec = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + ms;
  while (!acc.includes(needle)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${needle}; got ${acc}`);
    const r = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${needle}; got ${acc}`)), left))]);
    if (r.done) throw new Error(`stream ended before ${needle}; got ${acc}`);
    acc += dec.decode(r.value);
  }
  return acc;
}

describe('GET /api/stream', () => {
  it('requires authentication', async () => {
    const res = await stream.GET(new Request(ORIGIN + '/api/stream'));
    expect(res.status).toBe(401);
  });

  it('streams ready and then a change when a family member adds an event', async () => {
    const created = await post(createCal.POST, '/api/calendars', { familyName: 'S', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' });
    const dadCookie = created.headers.get('set-cookie')!.split(';')[0]!;
    const { calendar, member } = await created.json();
    const momRes = await post(join.POST, '/api/auth/join', { code: calendar.code, memberName: 'Mom', password: 'correct horse' });
    const momCookie = momRes.headers.get('set-cookie')!.split(';')[0]!;

    const ac = new AbortController();
    const res = await stream.GET(new Request(ORIGIN + '/api/stream', { headers: { cookie: dadCookie }, signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    await readUntil(reader, 'event: ready');

    await post(eventsRoute.POST, '/api/events', { title: 'From Mom', memberId: member.id, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' }, momCookie);
    const text = await readUntil(reader, 'event: change');
    expect(text).toContain('"type":"event"');
    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('closes the stream of a member who was removed', async () => {
    const created = await post(createCal.POST, '/api/calendars', { familyName: 'S2', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' });
    const dadCookie = created.headers.get('set-cookie')!.split(';')[0]!;
    const { calendar } = await created.json();
    const kidRes = await post(join.POST, '/api/auth/join', { code: calendar.code, memberName: 'Kid', password: 'correct horse' });
    const kidCookie = kidRes.headers.get('set-cookie')!.split(';')[0]!;
    const kidId = (await kidRes.json()).member.id as string;

    const res = await stream.GET(new Request(ORIGIN + '/api/stream', { headers: { cookie: kidCookie } }));
    const reader = res.body!.getReader();
    await readUntil(reader, 'event: ready');

    const del = await post(memberRoute.DELETE, `/api/members/${kidId}?events=keep`, undefined, dadCookie, { id: kidId }, 'DELETE');
    expect(del.status).toBe(200);
    // the change is delivered, then the stream ends because the session is gone
    await readUntil(reader, 'event: change');
    let ended = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !ended) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: false; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: false }), 1000)),
      ]);
      if (r.done) ended = true;
    }
    expect(ended).toBe(true);
  });
});
