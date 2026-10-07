import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

const ORIGIN = 'http://localhost:3000';
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let calendars: { POST: Handler };
let join: { POST: Handler };
let logout: { POST: Handler };
let me: { GET: Handler };
let calendarRoute: { GET: Handler; PATCH: Handler; DELETE: Handler };
let health: { GET: Handler };

beforeAll(async () => {
  const { url } = await createTestDb();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  process.env.APP_ORIGIN = ORIGIN;
  (process.env as Record<string, string>).NODE_ENV = 'test';
  calendars = await import('@/app/api/calendars/route');
  join = await import('@/app/api/auth/join/route');
  logout = await import('@/app/api/auth/logout/route');
  me = await import('@/app/api/auth/me/route');
  calendarRoute = await import('@/app/api/calendar/route');
  health = await import('@/app/api/health/route');
});
afterAll(stopTestServer);

function req(path: string, o: { method?: string; body?: unknown; cookie?: string; origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = o.cookie;
  return new Request(ORIGIN + path, {
    method: o.method ?? 'GET', headers,
    body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
}
const ctx = { params: Promise.resolve({}) };
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const create = (over: Record<string, unknown> = {}) =>
  calendars.POST(req('/api/calendars', { method: 'POST', body: { familyName: 'Fam', memberName: 'Dad', password: 'correct horse', timezone: 'UTC', ...over } }), ctx);

describe('calendar API', () => {
  it('creates a calendar: 201, HttpOnly cookie, no secrets in the body', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.calendar.code).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(body.recoveryCode).toBeTruthy();
    expect(text).not.toMatch(/correct horse|argon2|password_hash|passwordHash|recoveryHash/);
  });

  it('blocks cross-site and header-less mutations', async () => {
    const body = { familyName: 'Fam', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' };
    expect((await calendars.POST(req('/api/calendars', { method: 'POST', body, origin: null }), ctx)).status).toBe(403);
    expect((await calendars.POST(req('/api/calendars', { method: 'POST', body, origin: 'http://evil.example' }), ctx)).status).toBe(403);
    const noHeader = new Request(ORIGIN + '/api/calendars', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await calendars.POST(noHeader, ctx)).status).toBe(403);
  });

  it('returns 400 for invalid JSON and invalid fields', async () => {
    expect((await calendars.POST(req('/api/calendars', { method: 'POST', raw: '{nope' }), ctx)).status).toBe(400);
    const res = await create({ password: 'short' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION');
  });

  it('me requires a valid session', async () => {
    const created = await create({ familyName: 'MeFam' });
    const cookie = cookieOf(created);
    const ok = await me.GET(req('/api/auth/me', { cookie }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe('MeFam');
    expect((await me.GET(req('/api/auth/me'), ctx)).status).toBe(401);
    expect((await me.GET(req('/api/auth/me', { cookie: 'fc_session=garbage' }), ctx)).status).toBe(401);
  });

  it('join: wrong password is 401 generic, right password sets a cookie', async () => {
    const created = await (await create({ familyName: 'JoinFam' })).json();
    const code = created.calendar.code;
    const bad = await join.POST(req('/api/auth/join', { method: 'POST', body: { code, memberName: 'Mom', password: 'wrong-pass' } }), ctx);
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.message).toBe('Invalid calendar ID or password');
    const good = await join.POST(req('/api/auth/join', { method: 'POST', body: { code, memberName: 'Mom', password: 'correct horse' } }), ctx);
    expect(good.status).toBe(200);
    expect(good.headers.get('set-cookie')).toMatch(/fc_session=/);
    expect((await good.json()).status).toBe('joined');
  });

  it('logout revokes the session and clears the cookie', async () => {
    const cookie = cookieOf(await create());
    const out = await logout.POST(req('/api/auth/logout', { method: 'POST', cookie }), ctx);
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await me.GET(req('/api/auth/me', { cookie }), ctx)).status).toBe(401);
  });

  it('PATCH /api/calendar is owner-only', async () => {
    const created = await (await create({ familyName: 'PatchFam' })).json();
    const ownerCookie = cookieOf(await create({ familyName: 'Other' }));
    const memberRes = await join.POST(req('/api/auth/join', { method: 'POST', body: { code: created.calendar.code, memberName: 'Kid', password: 'correct horse' } }), ctx);
    const memberCookie = cookieOf(memberRes);
    const res = await calendarRoute.PATCH(req('/api/calendar', { method: 'PATCH', cookie: memberCookie, body: { name: 'Hacked' } }), ctx);
    expect(res.status).toBe(403);
    const ok = await calendarRoute.PATCH(req('/api/calendar', { method: 'PATCH', cookie: ownerCookie, body: { name: 'Renamed' } }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe('Renamed');
  });

  it('health reports ok', async () => {
    const res = await health.GET(req('/api/health'), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
