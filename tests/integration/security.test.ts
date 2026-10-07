import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

const ORIGIN = 'http://localhost:3000';
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Mod = Record<string, Handler>;

let mods: Record<string, Mod> = {};
let resetRateLimits: (now?: () => number) => void;

beforeAll(async () => {
  const { url } = await createTestDb();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = ORIGIN;
  mods = {
    calendars: await import('@/app/api/calendars/route'),
    join: await import('@/app/api/auth/join/route'),
    me: await import('@/app/api/auth/me/route'),
    calendar: await import('@/app/api/calendar/route'),
    password: await import('@/app/api/calendar/password/route'),
    members: await import('@/app/api/members/route'),
    member: await import('@/app/api/members/[id]/route'),
    invites: await import('@/app/api/invites/route'),
    invite: await import('@/app/api/invites/[id]/route'),
    events: await import('@/app/api/events/route'),
    event: await import('@/app/api/events/[id]/route'),
    history: await import('@/app/api/events/[id]/history/route'),
    restore: await import('@/app/api/events/[id]/restore/route'),
    conflicts: await import('@/app/api/conflicts/route'),
  } as unknown as Record<string, Mod>;
  ({ resetRateLimits } = await import('@/server/api'));
});
afterAll(stopTestServer);
beforeEach(() => resetRateLimits());

interface Req { cookie?: string; origin?: string | null; xrw?: boolean; body?: unknown; params?: Record<string, string> }
const send = (mod: string, method: string, path: string, o: Req = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.xrw !== false) headers['x-requested-with'] = 'fetch';
  if (o.cookie) headers.cookie = o.cookie;
  const handler = mods[mod]![method]!;
  return handler(new Request(ORIGIN + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
};

async function family(name: string) {
  const res = await send('calendars', 'POST', '/api/calendars', { body: { familyName: name, memberName: 'Dad', password: 'correct horse', timezone: 'UTC' } });
  const body = await res.json();
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const ev = await (await send('events', 'POST', '/api/events', {
    cookie, body: { title: name + ' secret', memberId: body.member.id, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' },
  })).json();
  const inv = await (await send('invites', 'POST', '/api/invites', { cookie, body: {} })).json();
  return { cookie, code: body.calendar.code as string, memberId: body.member.id as string, eventId: ev.eventId as string, inviteId: inv.id as string };
}

const UUID = '00000000-0000-4000-8000-000000000000';
// [module, method, path, body]  (:id is replaced per test)
const AUTH_ROUTES: [string, string, string, unknown?][] = [
  ['me', 'GET', '/api/auth/me'],
  ['calendar', 'GET', '/api/calendar'],
  ['calendar', 'PATCH', '/api/calendar', { name: 'x' }],
  ['calendar', 'DELETE', '/api/calendar', { confirmName: 'x' }],
  ['password', 'POST', '/api/calendar/password', { currentPassword: 'x', newPassword: 'long enough pw' }],
  ['members', 'GET', '/api/members'],
  ['member', 'DELETE', `/api/members/${UUID}?events=keep`],
  ['invites', 'GET', '/api/invites'],
  ['invites', 'POST', '/api/invites', {}],
  ['invite', 'DELETE', `/api/invites/${UUID}`],
  ['events', 'GET', '/api/events?from=2026-10-10&to=2026-10-11'],
  ['events', 'POST', '/api/events', { title: 'x', memberId: UUID, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' }],
  ['event', 'PATCH', `/api/events/${UUID}`, { version: 1 }],
  ['event', 'DELETE', `/api/events/${UUID}?version=1`],
  ['history', 'GET', `/api/events/${UUID}/history`],
  ['restore', 'POST', `/api/events/${UUID}/restore`],
  ['conflicts', 'GET', '/api/conflicts?from=2026-10-10&to=2026-10-11'],
];

describe('unauthenticated sweep', () => {
  for (const [mod, method, path, body] of AUTH_ROUTES) {
    it(`${method} ${path.split('?')[0]} requires a session`, async () => {
      const none = await send(mod, method, path, { body, params: { id: UUID } });
      expect(none.status).toBe(401);
      const garbage = await send(mod, method, path, { body, cookie: 'fc_session=garbage', params: { id: UUID } });
      expect(garbage.status).toBe(401);
    });
  }
});

describe('CSRF sweep', () => {
  const MUTATING = AUTH_ROUTES.filter(([, m]) => m !== 'GET');
  let f: Awaited<ReturnType<typeof family>>;
  beforeAll(async () => { resetRateLimits(); f = await family('Csrf'); });
  for (const [mod, method, path, body] of MUTATING) {
    it(`${method} ${path.split('?')[0]} blocks missing/foreign Origin and missing header`, async () => {
      const base = { body, cookie: f.cookie, params: { id: UUID } };
      expect((await send(mod, method, path, { ...base, origin: null })).status).toBe(403);
      expect((await send(mod, method, path, { ...base, origin: 'http://evil.example' })).status).toBe(403);
      expect((await send(mod, method, path, { ...base, xrw: false })).status).toBe(403);
    });
  }
  it('login/create endpoints are protected too', async () => {
    for (const [mod, path] of [['calendars', '/api/calendars'], ['join', '/api/auth/join']] as const) {
      expect((await send(mod, 'POST', path, { body: {}, origin: 'http://evil.example' })).status).toBe(403);
    }
  });
});

describe('tenant isolation sweep', () => {
  it("family B can never read or change family A's resources (always 404)", async () => {
    const a = await family('Alpha'); const b = await family('Beta');
    const ev = { params: { id: a.eventId } };
    const checks: [string, string, string, unknown?, Record<string, string>?][] = [
      ['event', 'PATCH', `/api/events/${a.eventId}`, { title: 'pwned', version: 1 }, ev.params],
      ['event', 'DELETE', `/api/events/${a.eventId}?version=1`, undefined, ev.params],
      ['history', 'GET', `/api/events/${a.eventId}/history`, undefined, ev.params],
      ['restore', 'POST', `/api/events/${a.eventId}/restore`, undefined, ev.params],
      ['member', 'DELETE', `/api/members/${a.memberId}?events=delete`, undefined, { id: a.memberId }],
      ['invite', 'DELETE', `/api/invites/${a.inviteId}`, undefined, { id: a.inviteId }],
    ];
    for (const [mod, method, path, body, params] of checks) {
      const res = await send(mod, method, path, { cookie: b.cookie, body, params });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // B's list never contains A's data; A's data is untouched.
    const list = await (await send('events', 'GET', '/api/events?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z', { cookie: b.cookie })).json();
    expect(JSON.stringify(list)).not.toContain('Alpha secret');
    const own = await (await send('events', 'GET', '/api/events?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z', { cookie: a.cookie })).json();
    expect(own.occurrences).toHaveLength(1);
    expect(own.occurrences[0].title).toBe('Alpha secret');
    const members = await (await send('members', 'GET', '/api/members', { cookie: b.cookie })).json();
    expect(members.members).toHaveLength(1);
    expect((await (await send('invites', 'GET', '/api/invites', { cookie: b.cookie })).json()).invites).toHaveLength(1);
  });

  it('creating an event for a member of another calendar is rejected', async () => {
    const a = await family('Gamma'); const b = await family('Delta');
    const res = await send('events', 'POST', '/api/events', {
      cookie: b.cookie, body: { title: 'x', memberId: a.memberId, allDay: false, start: '2026-10-10T10:00', end: '2026-10-10T11:00' },
    });
    expect(res.status).toBe(400);
  });
});

describe('secrets never leak', () => {
  it('no hashes or passwords appear in any response body', async () => {
    const res = await send('calendars', 'POST', '/api/calendars', { body: { familyName: 'Leak', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' } });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const texts = [await res.text()];
    for (const [mod, path] of [['me', '/api/auth/me'], ['calendar', '/api/calendar'], ['members', '/api/members'], ['invites', '/api/invites']] as const) {
      texts.push(await (await send(mod, 'GET', path, { cookie })).text());
    }
    for (const t of texts) expect(t).not.toMatch(/argon2|password_?hash|recovery_?hash|token_?hash|correct horse/i);
  });

  it('failed logins never write the attempted password to the logs', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { chunks.push(String(c)); return true; }) as never);
    try {
      const f = await family('Logs');
      await send('join', 'POST', '/api/auth/join', { body: { code: f.code, memberName: 'Mom', password: 'hunter2hunter2' } });
      await send('join', 'POST', '/api/auth/join', { body: { code: 'ZZZZ-9999', memberName: 'Mom', password: 'hunter2hunter2' } });
      await send('calendars', 'POST', '/api/calendars', { body: { familyName: 'x', memberName: 'y', password: 'hunter2hunter2', timezone: 'Mars/Nope' } });
    } finally {
      spy.mockRestore();
    }
    expect(chunks.join('')).not.toContain('hunter2hunter2');
  });
});

describe('rate limiting', () => {
  it('limits a session to 120 requests per minute', async () => {
    const f = await family('Rate');
    resetRateLimits(() => 1_000_000); // frozen clock: no refill, deterministic
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push((await send('me', 'GET', '/api/auth/me', { cookie: f.cookie })).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120).some((s) => s === 429)).toBe(true);
    resetRateLimits();
    // another member of another family is not affected
    const other = await family('RateOther');
    expect((await send('me', 'GET', '/api/auth/me', { cookie: other.cookie })).status).toBe(200);
  });
});
