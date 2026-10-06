# Family Shared Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready family shared calendar (calendar ID + password access, PostgreSQL, conflict detection, recurrence, audit, realtime, ops docs).

**Architecture:** One Next.js (App Router) TypeScript-strict app. Thin route handlers → services (business logic + authz) → repositories (Drizzle, always scoped by `calendar_id`) → PostgreSQL. SSE realtime fan-out via Postgres LISTEN/NOTIFY. Pure modules (conflicts, recurrence) have no I/O and are unit-tested first.

**Tech Stack:** Next.js 15, React 19, TypeScript strict, Drizzle ORM + drizzle-kit, postgres.js, Zod, `@node-rs/argon2`, `rrule`, Luxon, pino, Vitest, Playwright, `embedded-postgres` (dev/test DB).

**Spec:** `docs/superpowers/specs/2026-10-07-family-calendar-design.md`

**Spec amendment (discovered while planning):** `events` gets two extra nullable columns, `series_id uuid` and `recurrence_date date`, so "edit this occurrence" can create a linked override event. No other spec changes.

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`; no `any` in `src/`.
- Passwords: argon2id; never stored, logged or returned in plain text. Password length 8–128 chars (cap prevents hashing-DoS).
- Cookies: `HttpOnly; SameSite=Lax; Path=/`, `Secure` when `NODE_ENV=production`. DB stores only sha-256 of session/invite tokens.
- Conflict intervals are half-open `[start,end)`; touching events do not conflict; same-member double-booking is flagged; all-day events never conflict.
- Every repository function takes `calendarId` and filters by it. URL/body ids are never trusted for tenancy; cross-calendar access → 404.
- Error body shape: `{ "error": { "code": string, "message": string } }`. Statuses: 400, 401, 403, 404, 409, 429, 503.
- Auth failure message is exactly `Invalid calendar ID or password` for unknown code and wrong password.
- Times stored UTC (`timestamptz`); recurring events also store wall-clock + IANA tz.
- Occurrence expansion limits: range ≤ 366 days per request, ≤ 2000 occurrences.
- Event duration ≤ 7 days, `end > start`.
- Calendar code format `XXXX-NNNN` (4 letters A–Z excluding I/O, 4 digits).
- Commit after each task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Windows dev machine: run `git config core.longpaths true` (already set in this repo).

## Review Focus

1. **DST gap/overlap for recurring events** (e.g. daily 02:30 in `America/New_York` on spring-forward day): occurrence must still appear once, on the same date, at the nearest valid wall-clock time. Pinned in Task 4.
2. **Hostile/odd text input** (whitespace-only names, 10 000-char titles, control chars, emoji, `Éa` vs `éa` composed/decomposed): must be rejected or normalized, never crash or create "duplicate-looking" members. Pinned in Task 3 and Task 6.
3. **Concurrent identical joins/creates** (two phones joining as "Mom" at once; double-tapped Save): exactly one member / one event results, the loser gets a clean 409 or the original response. Pinned in Tasks 6 and 8.
4. **Owner self-removal / last owner / removed member with live session**: owner cannot be removed or leave the calendar ownerless; a removed member's session stops working immediately. Pinned in Task 7.
5. **Huge or invalid query ranges and timezones** (`from` after `to`, 50-year range, `Mars/Olympus`): 400, not a slow query or 500. Pinned in Tasks 3 and 8.

---

## File Structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, drizzle.config.ts, .env.example
src/config/env.ts                       env parsing
src/lib/errors.ts                       AppError
src/lib/validation.ts                   zod schemas + sanitizers
src/lib/time.ts                         tz helpers, day keys
src/lib/conflicts.ts                    pure overlap detection
src/lib/recurrence.ts                   pure RRULE build + expansion
src/server/logger.ts
src/server/db/schema.ts, client.ts, migrate.ts, migrations/*.sql
src/server/auth/password.ts, tokens.ts, session.ts, lockout.ts, request.ts
src/server/authz/policy.ts
src/server/services/calendars.ts, members.ts, invites.ts, events.ts, audit.ts, conflicts.ts
src/server/realtime/hub.ts, notify.ts
src/server/api.ts                       route wrapper (csrf, auth, errors, rate-limit)
src/server/security-headers.ts
src/app/api/**/route.ts
src/app/(pages)…                        landing, join, dashboard
src/components/**                       UI
tests/helpers/db.ts, tests/unit/**, tests/integration/**, tests/e2e/**
ops/Dockerfile, ops/docker-compose.yml, ops/Caddyfile, ops/backup.sh, ops/restore.sh, ops/RESTORE.md
docs/DEPLOY.md, docs/SECURITY_CHECKLIST.md
```

---

### Task 1: Scaffold, config, embedded-Postgres test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config/env.ts`, `src/lib/errors.ts`, `src/server/logger.ts`, `tests/helpers/db.ts`, `src/app/layout.tsx`, `src/app/page.tsx` (placeholder removed in Task 11), `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `getEnv(): Env` (`{NODE_ENV, DATABASE_URL, APP_ORIGIN, TRUST_PROXY:boolean, LOG_LEVEL}`), `class AppError extends Error {code:string; status:number}`, `logger` (pino), `createTestDb(): Promise<{url:string; close():Promise<void>}>` (fresh empty database per call, shared embedded server).

- [ ] **Step 1: Initialize project**

```bash
npm init -y
npm install next@15 react@19 react-dom@19 zod drizzle-orm postgres @node-rs/argon2 rrule luxon pino
npm install -D typescript @types/node @types/react @types/react-dom @types/luxon vitest drizzle-kit embedded-postgres @playwright/test eslint tsx
```

Set scripts in `package.json`:
```json
"scripts": {
  "dev": "tsx scripts/dev.ts",
  "build": "next build",
  "start": "next start",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/server/db/migrate.ts",
  "test": "vitest run",
  "test:e2e": "playwright test",
  "lint": "next lint",
  "typecheck": "tsc --noEmit"
}
```

`tsconfig.json`: standard Next config plus `"strict": true, "noUncheckedIndexedAccess": true, "paths": {"@/*": ["./src/*"]}`.

- [ ] **Step 2: Write failing env test** — `tests/unit/env.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseEnv } from '@/config/env';

describe('parseEnv', () => {
  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
  it('parses defaults', () => {
    const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ORIGIN: 'http://localhost:3000' });
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('requires https APP_ORIGIN in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_ORIGIN: 'http://a.com' })).toThrow(/https/);
  });
});
```

- [ ] **Step 3: Run** `npx vitest run tests/unit/env.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** `src/config/env.ts`

```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new Error('Invalid environment: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  if (r.data.NODE_ENV === 'production' && !r.data.APP_ORIGIN.startsWith('https://')) {
    throw new Error('Invalid environment: APP_ORIGIN must be https in production');
  }
  return r.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
```

`src/lib/errors.ts`:
```ts
export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INTERNAL';
const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, RATE_LIMITED: 429, UNAVAILABLE: 503, INTERNAL: 500,
};
export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.status = STATUS[code];
  }
}
```

`src/server/logger.ts`:
```ts
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['password', '*.password', 'newPassword', 'recoveryCode', 'token', 'req.headers.cookie', 'req.headers.authorization'], censor: '[redacted]' },
});
```

- [ ] **Step 5: Test harness** `tests/helpers/db.ts` (starts one embedded PG per vitest worker, creates a uniquely named database per call)

```ts
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let server: EmbeddedPostgres | undefined;
let starting: Promise<number> | undefined;

async function ensureServer(): Promise<number> {
  if (process.env.TEST_DATABASE_URL_BASE) return 0; // external PG (CI)
  starting ??= (async () => {
    const port = 54000 + Math.floor(Math.random() * 1000);
    server = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), 'fc-pg-')),
      user: 'postgres', password: 'postgres', port, persistent: false,
    });
    await server.initialise();
    await server.start();
    return port;
  })();
  return starting;
}

export async function createTestDb() {
  const port = await ensureServer();
  const base = process.env.TEST_DATABASE_URL_BASE ?? `postgres://postgres:postgres@localhost:${port}`;
  const name = 'test_' + randomBytes(6).toString('hex');
  const admin = postgres(`${base}/postgres`, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    url: `${base}/${name}`,
    async close() {
      if (server && !process.env.TEST_DATABASE_URL_BASE) { /* server stopped in globalTeardown */ }
    },
  };
}

export async function stopTestServer() {
  if (server) { await server.stop(); server = undefined; starting = undefined; }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000, pool: 'forks' },
});
```

Add `.gitignore` (`node_modules`, `.next`, `.env*` except `.env.example`, `test-results`), `.env.example` with `DATABASE_URL`, `APP_ORIGIN`, `TRUST_PROXY`, `LOG_LEVEL`. Add minimal `src/app/layout.tsx` and `src/app/page.tsx` so `next build` passes.

- [ ] **Step 6: Run** `npx vitest run tests/unit/env.test.ts` → PASS; `npx tsc --noEmit` → PASS.
- [ ] **Step 7: Smoke-test harness** — write `tests/integration/harness.test.ts`: `createTestDb()`, connect with `postgres(url)`, `select 1 as x` → `x === 1`; `afterAll(stopTestServer)`. Run → PASS. (If `embedded-postgres` cannot download binaries, set `TEST_DATABASE_URL_BASE` to any reachable Postgres and report that to the user.)
- [ ] **Step 8: Commit** `git add -A && git commit -m "chore: scaffold app, env config, embedded postgres test harness"`

---

### Task 2: Database schema and migrations

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/migrate.ts`, `drizzle.config.ts`, `src/server/db/migrations/` (generated), `tests/integration/schema.test.ts`

**Interfaces:**
- Consumes: `createTestDb`.
- Produces: Drizzle tables `calendars, members, sessions, events, eventAudit, invites, authAttempts, idempotencyKeys`; `type Db = PostgresJsDatabase<typeof schema>`; `getDb(): Db`; `getSql(): Sql`; `createDb(url): {db: Db; sql: Sql}`; `runMigrations(url): Promise<void>`.

- [ ] **Step 1: Write failing tests** `tests/integration/schema.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

let sql: postgres.Sql; let url: string;
beforeAll(async () => { ({ url } = await createTestDb()); await runMigrations(url); sql = postgres(url); });
afterAll(async () => { await sql.end(); await stopTestServer(); });

const cal = () => sql`insert into calendars (code,name,password_hash,recovery_hash,timezone) values (${'ABCD-' + Math.floor(1000 + Math.random() * 8999)},'F','h','r','UTC') returning id`;
const mem = (c: string, name: string, role = 'member') =>
  sql`insert into members (calendar_id,name,name_key,role,color) values (${c},${name},${name.toLowerCase()},${role},'#fff') returning id`;

describe('schema', () => {
  it('migrations are idempotent', async () => { await runMigrations(url); });

  it('rejects event whose member belongs to another calendar', async () => {
    const [a] = await cal(); const [b] = await cal();
    const [m] = await mem(a!.id, 'Mom');
    await expect(sql`insert into events (calendar_id,member_id,title,start_utc,end_utc,tz,created_by,updated_by)
      values (${b!.id},${m!.id},'x',now(),now()+interval '1 hour','UTC',${m!.id},${m!.id})`).rejects.toThrow();
  });

  it('rejects end <= start and durations over 7 days', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Dad');
    await expect(sql`insert into events (calendar_id,member_id,title,start_utc,end_utc,tz,created_by,updated_by)
      values (${a!.id},${m!.id},'x',now(),now(),'UTC',${m!.id},${m!.id})`).rejects.toThrow();
    await expect(sql`insert into events (calendar_id,member_id,title,start_utc,end_utc,tz,created_by,updated_by)
      values (${a!.id},${m!.id},'x',now(),now()+interval '8 days','UTC',${m!.id},${m!.id})`).rejects.toThrow();
  });

  it('enforces unique active member name per calendar, case-insensitively via name_key', async () => {
    const [a] = await cal(); await mem(a!.id, 'Mom');
    await expect(mem(a!.id, 'MOM')).rejects.toThrow();
  });

  it('allows reuse of a name after removal', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Kid');
    await sql`update members set removed_at = now() where id = ${m!.id}`;
    await mem(a!.id, 'Kid');
  });

  it('cascades calendar deletion to members, events and audit', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Z');
    const [e] = await sql`insert into events (calendar_id,member_id,title,start_utc,end_utc,tz,created_by,updated_by)
      values (${a!.id},${m!.id},'x',now(),now()+interval '1 hour','UTC',${m!.id},${m!.id}) returning id`;
    await sql`insert into event_audit (calendar_id,event_id,action,actor_member_id) values (${a!.id},${e!.id},'create',${m!.id})`;
    await sql`delete from calendars where id = ${a!.id}`;
    expect((await sql`select 1 from events where calendar_id=${a!.id}`).length).toBe(0);
    expect((await sql`select 1 from event_audit where calendar_id=${a!.id}`).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run** → FAIL (no migrate module).
- [ ] **Step 3: Implement schema** `src/server/db/schema.ts` per spec §4 with Drizzle `pgTable`. Required details:
  - `calendars.owner_member_id` has **no FK constraint in Drizzle**; instead add it in a hand-written migration `0001_owner_fk.sql` as `ALTER TABLE calendars ADD CONSTRAINT calendars_owner_fk FOREIGN KEY (owner_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED;` (circular reference).
  - `members`: `unique('members_cal_id_uq').on(calendarId, id)`; partial unique index `uniqueIndex('members_active_name_uq').on(calendarId, nameKey).where(sql\`removed_at is null\`)`; `calendar_id` FK `onDelete: 'cascade'`.
  - `events`: composite FK `foreignKey({columns:[calendarId, memberId], foreignColumns:[members.calendarId, members.id]})`; `created_by`/`updated_by` uuid not null (no FK, preserves history); CHECKs `end_utc > start_utc` and `end_utc - start_utc <= interval '7 days'`; columns `series_id uuid`, `recurrence_date date`, `exceptions jsonb not null default '[]'`, `version integer not null default 1`, `all_day boolean not null default false`, `tz text not null`, `local_start timestamp`, `local_end timestamp`, `rrule text`, `recur_until timestamptz`, `deleted_at`.
  - Indexes per spec §4. `event_audit.calendar_id` FK cascade; `event_audit.event_id` plain uuid (no FK so purge order doesn't matter; cascade by calendar).
  - `sessions`: composite FK to members; `token_hash text unique`.
  - `idempotency_keys`: PK `(key, calendar_id)`.
  - `gen_random_uuid()` defaults, `timestamptz default now()`.

  `src/server/db/client.ts`:
```ts
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { getEnv } from '@/config/env';

export type Db = PostgresJsDatabase<typeof schema>;
export function createDb(url: string, max = 10) {
  const sql = postgres(url, { max, idle_timeout: 20, connect_timeout: 10 });
  return { sql, db: drizzle(sql, { schema }) };
}
let shared: ReturnType<typeof createDb> | undefined;
export const getDb = (): Db => (shared ??= createDb(getEnv().DATABASE_URL)).db;
export const getSql = () => (shared ??= createDb(getEnv().DATABASE_URL)).sql;
```
  `src/server/db/migrate.ts`:
```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { createDb } from './client';

export async function runMigrations(url: string) {
  const { db, sql } = createDb(url, 1);
  try { await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src/server/db/migrations') }); }
  finally { await sql.end(); }
}
if (process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations(process.env.DATABASE_URL ?? '').then(() => { console.log('migrated'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
```
  `drizzle.config.ts`: `{ schema: './src/server/db/schema.ts', out: './src/server/db/migrations', dialect: 'postgresql' }`.
- [ ] **Step 4: Generate** `npx drizzle-kit generate`; then `npx drizzle-kit generate --custom --name owner_fk` and paste the ALTER TABLE statement above into the created SQL file.
- [ ] **Step 5: Run** `npx vitest run tests/integration/schema.test.ts` → PASS. Fix schema until all pass.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(db): schema, constraints, indexes, migrations"`

---

### Task 3: Validation, sanitizers, time helpers

**Files:**
- Create: `src/lib/validation.ts`, `src/lib/time.ts`, `tests/unit/validation.test.ts`, `tests/unit/time.test.ts`

**Interfaces:**
- Produces:
  - `cleanText(s: string): string` — NFC-normalize, strip control chars (except `\n` in descriptions), trim.
  - `nameKey(name: string): string` — `cleanText(name).normalize('NFKC').toLowerCase()`, collapse internal whitespace.
  - Schemas: `createCalendarSchema {familyName, memberName, password, timezone}`, `joinSchema {code, memberName, password, confirmExisting?:boolean}`, `eventInputSchema`, `eventPatchSchema`, `rangeSchema {from:Date,to:Date}`, `recurrenceInputSchema`, `passwordSchema`, `timezoneSchema`.
  - `RecurrenceInput = {freq:'daily'|'weekdays'|'weekly'|'monthly'|'custom'; interval?:number; byDay?:('MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU')[]; until?:string(YYYY-MM-DD); count?:number}`
  - `EventInput = {title; memberId; description?; location?; allDay:boolean; start:string(local ISO 'YYYY-MM-DDTHH:mm'); end:string; tz?:string; recurrence?:RecurrenceInput}` — local wall-clock strings interpreted in calendar tz.
  - `isValidTimezone(tz): boolean`, `toUtc(local: string, tz: string): Date`, `dayKey(d: Date, tz: string): string` (`YYYY-MM-DD`), `dayBounds(day: string, tz): {start: Date; end: Date}`.

- [ ] **Step 1: Failing tests**

```ts
// tests/unit/validation.test.ts
import { describe, it, expect } from 'vitest';
import { cleanText, nameKey, createCalendarSchema, rangeSchema, eventInputSchema } from '@/lib/validation';

describe('text', () => {
  it('strips control chars and trims', () => { expect(cleanText('  a\u0000b\u0007  ')).toBe('ab'); });
  it('nameKey treats composed/decomposed and case alike', () => {
    expect(nameKey('Éa')).toBe(nameKey('ÉA'));
    expect(nameKey('  Mom   Smith ')).toBe('mom smith');
  });
});
describe('schemas', () => {
  const base = { familyName: 'Fam', memberName: 'Dad', password: 'correct horse', timezone: 'Australia/Melbourne' };
  it('accepts valid create', () => { expect(createCalendarSchema.safeParse(base).success).toBe(true); });
  it('rejects whitespace-only names', () => {
    expect(createCalendarSchema.safeParse({ ...base, memberName: '   ' }).success).toBe(false);
  });
  it('rejects short and 129-char passwords', () => {
    expect(createCalendarSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(createCalendarSchema.safeParse({ ...base, password: 'x'.repeat(129) }).success).toBe(false);
  });
  it('rejects invalid timezone', () => {
    expect(createCalendarSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
  });
  it('rejects 10000-char title', () => {
    const r = eventInputSchema.safeParse({ title: 'x'.repeat(10000), memberId: crypto.randomUUID(), allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T19:00' });
    expect(r.success).toBe(false);
  });
  it('rejects range with from after to and >366 days', () => {
    expect(rangeSchema.safeParse({ from: '2026-10-10', to: '2026-10-01' }).success).toBe(false);
    expect(rangeSchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(false);
  });
});
```
```ts
// tests/unit/time.test.ts
import { describe, it, expect } from 'vitest';
import { toUtc, dayKey, dayBounds, isValidTimezone } from '@/lib/time';

describe('time', () => {
  it('converts local wall clock to UTC', () => {
    expect(toUtc('2026-10-10T18:00', 'Australia/Melbourne').toISOString()).toBe('2026-10-10T07:00:00.000Z');
  });
  it('dayKey uses the calendar timezone', () => {
    expect(dayKey(new Date('2026-10-10T20:00:00Z'), 'Australia/Melbourne')).toBe('2026-10-11');
  });
  it('dayBounds spans 23h on DST start day', () => {
    const { start, end } = dayBounds('2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
  });
  it('validates timezones', () => { expect(isValidTimezone('Mars/Olympus')).toBe(false); expect(isValidTimezone('UTC')).toBe(true); });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/lib/time.ts`

```ts
import { DateTime } from 'luxon';

export const isValidTimezone = (tz: string) => DateTime.local().setZone(tz).isValid;
export function toUtc(local: string, tz: string): Date {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) throw new Error('Invalid date/time');
  return dt.toUTC().toJSDate();
}
export const dayKey = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).toFormat('yyyy-MM-dd');
export function dayBounds(day: string, tz: string) {
  const s = DateTime.fromISO(day, { zone: tz }).startOf('day');
  return { start: s.toUTC().toJSDate(), end: s.plus({ days: 1 }).startOf('day').toUTC().toJSDate() };
}
```
  `src/lib/validation.ts`:
```ts
import { z } from 'zod';
import { isValidTimezone } from './time';

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const cleanText = (s: string) => s.normalize('NFC').replace(CTRL, '').trim();
export const nameKey = (s: string) => cleanText(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

const text = (max: number, min = 1) =>
  z.string().transform(cleanText).pipe(z.string().min(min, 'Required').max(max));
const optText = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max)).optional();
export const passwordSchema = z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters');
export const timezoneSchema = z.string().refine(isValidTimezone, 'Unknown timezone');
export const codeSchema = z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{4}-\d{4}$/, 'Invalid calendar ID'));

export const createCalendarSchema = z.object({
  familyName: text(60), memberName: text(40), password: passwordSchema, timezone: timezoneSchema,
});
export const joinSchema = z.object({
  code: codeSchema, memberName: text(40), password: passwordSchema.or(z.string().min(1).max(128)),
  confirmExisting: z.boolean().optional(), inviteToken: z.string().max(200).optional(),
});
const localDt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm');
const DAYS = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export const recurrenceInputSchema = z.object({
  freq: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'custom']),
  interval: z.number().int().min(1).max(52).optional(),
  byDay: z.array(DAYS).max(7).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;
export const eventInputSchema = z.object({
  title: text(120), memberId: z.string().uuid(), description: optText(2000), location: optText(200),
  allDay: z.boolean(), start: localDt, end: localDt, recurrence: recurrenceInputSchema.optional(),
});
export type EventInput = z.infer<typeof eventInputSchema>;
export const eventPatchSchema = eventInputSchema.partial().extend({
  version: z.number().int().min(1),
  scope: z.enum(['this', 'series']).default('series'),
  occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const rangeSchema = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine(
  (r) => r.from < r.to && r.to.getTime() - r.from.getTime() <= 366 * 86400000, 'Invalid range (max 366 days)');
```
- [ ] **Step 4: Run** both test files → PASS. Fix until green (note `joinSchema.password` accepts any 1–128 chars so a user with an old shorter password is never blocked from logging in; creation enforces ≥ 8).
- [ ] **Step 5: Commit** `git commit -am "feat: validation schemas and time helpers"` (after `git add -A`)

---

### Task 4: Pure conflict detection and recurrence expansion

**Files:**
- Create: `src/lib/conflicts.ts`, `src/lib/recurrence.ts`, `tests/unit/conflicts.test.ts`, `tests/unit/recurrence.test.ts`

**Interfaces:**
- Consumes: `RecurrenceInput` (Task 3), `toUtc/dayKey` (Task 3).
- Produces:
```ts
export interface Occurrence { eventId: string; memberId: string; title: string; start: Date; end: Date; allDay: boolean; occurrenceDate: string /* YYYY-MM-DD local */; }
export interface Overlap { a: Occurrence; b: Occurrence; start: Date; end: Date; sameMember: boolean; }
export interface ConflictGroup { occurrences: Occurrence[]; overlaps: Overlap[]; start: Date; end: Date; days: string[]; }
export function findOverlaps(occ: Occurrence[]): Overlap[];
export function groupConflicts(overlaps: Overlap[], tz: string): ConflictGroup[];
export function dayStatuses(occ: Occurrence[], groups: ConflictGroup[], tz: string): Record<string, 'scheduled'|'conflict'>;

export function buildRRule(r: RecurrenceInput): string;           // e.g. 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
export interface SeriesSource { id: string; memberId: string; title: string; allDay: boolean; tz: string; localStart: string; localEnd: string; rrule: string; exceptions: string[]; recurUntil: Date | null; }
export function expandSeries(s: SeriesSource, from: Date, to: Date, limit?: number): Occurrence[];
```

- [ ] **Step 1: Failing conflict tests**

```ts
// tests/unit/conflicts.test.ts
import { describe, it, expect } from 'vitest';
import { findOverlaps, groupConflicts, dayStatuses, type Occurrence } from '@/lib/conflicts';

const occ = (id: string, member: string, s: string, e: string, allDay = false): Occurrence => ({
  eventId: id, memberId: member, title: id, start: new Date(s), end: new Date(e), allDay, occurrenceDate: s.slice(0, 10),
});
const Z = (t: string) => `2026-10-10T${t}:00Z`;

describe('findOverlaps', () => {
  it('partial overlap returns the overlap window', () => {
    const o = findOverlaps([occ('A', 'dad', Z('10:00'), Z('12:00')), occ('B', 'mom', Z('11:30'), Z('13:00'))]);
    expect(o).toHaveLength(1);
    expect(o[0]!.start.toISOString()).toBe(Z('11:30').replace(':00Z', ':00.000Z'));
    expect(o[0]!.end.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(o[0]!.sameMember).toBe(false);
  });
  it('touching events do not conflict', () => {
    expect(findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'm', Z('11:00'), Z('12:00'))])).toHaveLength(0);
  });
  it('identical start conflicts', () => {
    expect(findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'm', Z('10:00'), Z('10:30'))])).toHaveLength(1);
  });
  it('containment conflicts', () => {
    expect(findOverlaps([occ('A', 'd', Z('09:00'), Z('17:00')), occ('B', 'm', Z('12:00'), Z('13:00'))])).toHaveLength(1);
  });
  it('same-member double booking conflicts and is flagged', () => {
    const o = findOverlaps([occ('A', 'd', Z('10:00'), Z('11:00')), occ('B', 'd', Z('10:30'), Z('11:30'))]);
    expect(o[0]!.sameMember).toBe(true);
  });
  it('all-day events never conflict', () => {
    expect(findOverlaps([occ('A', 'd', '2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z', true), occ('B', 'm', Z('10:00'), Z('11:00'))])).toHaveLength(0);
  });
  it('three mutually overlapping events produce 3 pairs', () => {
    const o = findOverlaps([occ('A', 'a', Z('10:00'), Z('12:00')), occ('B', 'b', Z('10:30'), Z('12:30')), occ('C', 'c', Z('11:00'), Z('13:00'))]);
    expect(o).toHaveLength(3);
  });
  it('is order-independent', () => {
    const list = [occ('B', 'm', Z('11:30'), Z('13:00')), occ('A', 'd', Z('10:00'), Z('12:00'))];
    expect(findOverlaps(list)).toHaveLength(1);
  });
});
describe('groupConflicts + dayStatuses', () => {
  it('chains A-B and B-C into one group', () => {
    const list = [occ('A', 'a', Z('10:00'), Z('11:00')), occ('B', 'b', Z('10:30'), Z('12:00')), occ('C', 'c', Z('11:30'), Z('12:30'))];
    const groups = groupConflicts(findOverlaps(list), 'UTC');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences.map((x) => x.eventId).sort()).toEqual(['A', 'B', 'C']);
  });
  it('event crossing midnight marks both days; status conflict beats scheduled', () => {
    const list = [occ('A', 'a', '2026-10-10T23:00:00Z', '2026-10-11T02:00:00Z'), occ('B', 'b', '2026-10-11T01:00:00Z', '2026-10-11T03:00:00Z'), occ('C', 'c', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z')];
    const groups = groupConflicts(findOverlaps(list), 'UTC');
    const st = dayStatuses(list, groups, 'UTC');
    expect(st['2026-10-10']).toBe('scheduled');
    expect(st['2026-10-11']).toBe('conflict');
    expect(st['2026-10-12']).toBe('scheduled');
    expect(st['2026-10-13']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/lib/conflicts.ts`

```ts
import { DateTime } from 'luxon';
// types as in Interfaces above

export function findOverlaps(all: Occurrence[]): Overlap[] {
  const timed = all.filter((o) => !o.allDay).sort((x, y) => x.start.getTime() - y.start.getTime() || x.eventId.localeCompare(y.eventId));
  const out: Overlap[] = [];
  let active: Occurrence[] = [];
  for (const cur of timed) {
    active = active.filter((a) => a.end.getTime() > cur.start.getTime());
    for (const a of active) {
      const start = new Date(Math.max(a.start.getTime(), cur.start.getTime()));
      const end = new Date(Math.min(a.end.getTime(), cur.end.getTime()));
      if (end > start) out.push({ a, b: cur, start, end, sameMember: a.memberId === cur.memberId });
    }
    active.push(cur);
  }
  return out;
}

const key = (o: Occurrence) => `${o.eventId}@${o.occurrenceDate}`;
export function groupConflicts(overlaps: Overlap[], tz: string): ConflictGroup[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  const byKey = new Map<string, Occurrence>();
  for (const ov of overlaps) for (const o of [ov.a, ov.b]) { byKey.set(key(o), o); if (!parent.has(key(o))) parent.set(key(o), key(o)); }
  for (const ov of overlaps) parent.set(find(key(ov.a)), find(key(ov.b)));
  const groups = new Map<string, ConflictGroup>();
  for (const [k, o] of byKey) {
    const r = find(k);
    const g = groups.get(r) ?? { occurrences: [], overlaps: [], start: o.start, end: o.end, days: [] };
    g.occurrences.push(o); if (o.start < g.start) g.start = o.start; if (o.end > g.end) g.end = o.end;
    groups.set(r, g);
  }
  for (const ov of overlaps) groups.get(find(key(ov.a)))!.overlaps.push(ov);
  return [...groups.values()].map((g) => {
    const days = new Set<string>();
    for (const ov of g.overlaps) for (const d of daysSpanned(ov.start, ov.end, tz)) days.add(d);
    return { ...g, days: [...days].sort() };
  }).sort((x, y) => x.start.getTime() - y.start.getTime());
}

function daysSpanned(start: Date, end: Date, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromJSDate(start, { zone: tz }).startOf('day');
  const last = DateTime.fromJSDate(new Date(end.getTime() - 1), { zone: tz }).startOf('day');
  while (d <= last) { out.push(d.toFormat('yyyy-MM-dd')); d = d.plus({ days: 1 }); }
  return out;
}

export function dayStatuses(occ: Occurrence[], groups: ConflictGroup[], tz: string): Record<string, 'scheduled' | 'conflict'> {
  const res: Record<string, 'scheduled' | 'conflict'> = {};
  for (const o of occ) for (const d of daysSpanned(o.start, o.end, tz)) res[d] = 'scheduled';
  for (const g of groups) for (const d of g.days) res[d] = 'conflict';
  return res;
}
```

- [ ] **Step 4: Run conflicts tests** → PASS.
- [ ] **Step 5: Failing recurrence tests**

```ts
// tests/unit/recurrence.test.ts
import { describe, it, expect } from 'vitest';
import { buildRRule, expandSeries, type SeriesSource } from '@/lib/recurrence';

const base = (over: Partial<SeriesSource> = {}): SeriesSource => ({
  id: 's', memberId: 'm', title: 'School', allDay: false, tz: 'Australia/Melbourne',
  localStart: '2026-10-05T08:30', localEnd: '2026-10-05T15:30', rrule: buildRRule({ freq: 'weekdays' }),
  exceptions: [], recurUntil: null, ...over,
});
const days = (os: { occurrenceDate: string }[]) => os.map((o) => o.occurrenceDate);

describe('buildRRule', () => {
  it('maps presets', () => {
    expect(buildRRule({ freq: 'daily' })).toBe('FREQ=DAILY');
    expect(buildRRule({ freq: 'weekdays' })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(buildRRule({ freq: 'weekly', interval: 2, count: 4 })).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=4');
    expect(buildRRule({ freq: 'custom', interval: 1, byDay: ['MO', 'WE'], until: '2026-12-31' })).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z');
  });
});
describe('expandSeries', () => {
  it('weekdays only, keeps wall clock', () => {
    const os = expandSeries(base(), new Date('2026-10-04T13:00:00Z'), new Date('2026-10-12T13:00:00Z'));
    expect(days(os)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
    expect(os[0]!.start.toISOString()).toBe('2026-10-04T21:30:00.000Z'); // 08:30 AEDT(+11) on Oct 5
  });
  it('skips exceptions', () => {
    expect(days(expandSeries(base({ exceptions: ['2026-10-06'] }), new Date('2026-10-04T13:00:00Z'), new Date('2026-10-08T13:00:00Z')))).toEqual(['2026-10-05', '2026-10-07']);
  });
  it('respects recurUntil and COUNT', () => {
    expect(expandSeries(base({ rrule: 'FREQ=DAILY;COUNT=2' }), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toHaveLength(2);
    expect(expandSeries(base({ rrule: 'FREQ=DAILY', recurUntil: new Date('2026-10-07T00:00:00Z') }), new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toHaveLength(2);
  });
  it('wall-clock stays 09:00 across DST change (Melbourne spring forward 2026-10-04)', () => {
    const os = expandSeries(base({ rrule: 'FREQ=DAILY', localStart: '2026-10-01T09:00', localEnd: '2026-10-01T10:00' }), new Date('2026-09-30T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    const before = os.find((o) => o.occurrenceDate === '2026-10-03')!;
    const after = os.find((o) => o.occurrenceDate === '2026-10-05')!;
    expect(before.start.toISOString()).toBe('2026-10-02T23:00:00.000Z'); // +10
    expect(after.start.toISOString()).toBe('2026-10-04T22:00:00.000Z'); // +11
  });
  it('02:30 daily in New York on spring-forward day still occurs once that day', () => {
    const os = expandSeries(base({ tz: 'America/New_York', rrule: 'FREQ=DAILY', localStart: '2026-03-07T02:30', localEnd: '2026-03-07T03:00' }), new Date('2026-03-07T00:00:00Z'), new Date('2026-03-10T00:00:00Z'));
    expect(os.filter((o) => o.occurrenceDate === '2026-03-08')).toHaveLength(1);
  });
  it('event crossing midnight keeps duration', () => {
    const os = expandSeries(base({ rrule: 'FREQ=DAILY', localStart: '2026-10-05T22:00', localEnd: '2026-10-06T02:00' }), new Date('2026-10-04T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect((os[0]!.end.getTime() - os[0]!.start.getTime()) / 3600000).toBe(4);
  });
  it('caps results at limit', () => {
    expect(expandSeries(base({ rrule: 'FREQ=DAILY' }), new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), 10)).toHaveLength(10);
  });
});
```

- [ ] **Step 6: Run** → FAIL.
- [ ] **Step 7: Implement** `src/lib/recurrence.ts`

```ts
import { RRule, rrulestr } from 'rrule';
import { DateTime } from 'luxon';
import type { RecurrenceInput } from './validation';
import type { Occurrence } from './conflicts';

export function buildRRule(r: RecurrenceInput): string {
  const parts: string[] = [];
  const interval = r.interval && r.interval > 1 ? r.interval : undefined;
  switch (r.freq) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekdays': parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR'); break;
    case 'weekly': parts.push('FREQ=WEEKLY'); if (r.byDay?.length) parts.push('BYDAY=' + r.byDay.join(',')); break;
    case 'monthly': parts.push('FREQ=MONTHLY'); break;
    case 'custom': parts.push('FREQ=WEEKLY'); if (r.byDay?.length) parts.push('BYDAY=' + r.byDay.join(',')); break;
  }
  if (interval) parts.splice(1, 0, `INTERVAL=${interval}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replaceAll('-', '')}T235959Z`);
  return parts.join(';');
}
```
  NOTE for implementer: the test for `weekdays` expects `FREQ=WEEKLY;BYDAY=...` and for `weekly` with interval expects `FREQ=WEEKLY;INTERVAL=2;COUNT=4`; the `splice(1,0,…)` places INTERVAL right after FREQ. Run the test to confirm ordering.

```ts
export interface SeriesSource { /* as in Interfaces */ }

/** Occurrences are generated in "floating" UTC (wall-clock fields stored as UTC),
 *  then each wall-clock is resolved in the series tz, so DST never shifts local time. */
export function expandSeries(s: SeriesSource, from: Date, to: Date, limit = 2000): Occurrence[] {
  const startLocal = DateTime.fromISO(s.localStart, { zone: 'utc' });
  const endLocal = DateTime.fromISO(s.localEnd, { zone: 'utc' });
  const durationMs = toInstant(s.localEnd, s.tz).getTime() - toInstant(s.localStart, s.tz).getTime();
  const rule = rrulestr(`DTSTART:${startLocal.toFormat("yyyyMMdd'T'HHmmss'Z'")}\nRRULE:${s.rrule}`) as RRule;
  // widen by 8 days to catch occurrences that start before `from` but end inside it
  const winFrom = DateTime.fromJSDate(from, { zone: s.tz }).minus({ days: 8 }).setZone('utc', { keepLocalTime: true }).toJSDate();
  const winTo = DateTime.fromJSDate(to, { zone: s.tz }).plus({ days: 1 }).setZone('utc', { keepLocalTime: true }).toJSDate();
  const out: Occurrence[] = [];
  for (const d of rule.between(winFrom, winTo, true)) {
    const wall = DateTime.fromJSDate(d, { zone: 'utc' });
    const date = wall.toFormat('yyyy-MM-dd');
    if (s.exceptions.includes(date)) continue;
    const start = DateTime.fromObject({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute }, { zone: s.tz }).toJSDate();
    if (s.recurUntil && start > s.recurUntil) continue;
    const end = new Date(start.getTime() + durationMs);
    if (end <= from || start >= to) continue;
    out.push({ eventId: s.id, memberId: s.memberId, title: s.title, start, end, allDay: s.allDay, occurrenceDate: date });
    if (out.length >= limit) break;
  }
  return out;
}
const toInstant = (local: string, tz: string) => DateTime.fromISO(local, { zone: tz }).toJSDate();
```
  (`endLocal` unused — remove it. Luxon resolves nonexistent local times like 02:30 on spring-forward day by shifting forward, which satisfies the "occurs once" test.)
- [ ] **Step 8: Run** `npx vitest run tests/unit` → PASS. Debug test expectations against real output only if the *reasoning* is verified (e.g. confirm Melbourne offsets), never loosen assertions to match bugs.
- [ ] **Step 9: Commit** `git add -A && git commit -m "feat: pure conflict detection and recurrence expansion"`

---

### Task 5: Auth primitives and authorization policy

**Files:**
- Create: `src/server/auth/password.ts`, `tokens.ts`, `lockout.ts`, `session.ts`, `src/server/authz/policy.ts`, `tests/unit/policy.test.ts`, `tests/integration/auth-primitives.test.ts`

**Interfaces:**
- Consumes: `Db`, tables (Task 2), `AppError`.
- Produces:
```ts
export interface Actor { calendarId: string; memberId: string; role: 'owner' | 'member' }
// password.ts
hashPassword(p: string): Promise<string>; verifyPassword(hash: string, p: string): Promise<boolean>; verifyDummy(p: string): Promise<void>;
// tokens.ts
newToken(): string /* 32 bytes base64url */; hashToken(t: string): string /* sha256 hex */; newCalendarCode(): string; newRecoveryCode(): string /* 'XXXX-XXXX-XXXX' */;
// lockout.ts
assertNotLocked(db: Db, keys: string[]): Promise<void> /* throws AppError RATE_LIMITED */; recordFailure(db: Db, keys: string[]): Promise<void>; clearFailures(db: Db, keys: string[]): Promise<void>;
// session.ts
createSession(db: Db, calendarId: string, memberId: string, userAgent?: string): Promise<{ token: string; expiresAt: Date }>;
resolveSession(db: Db, token: string): Promise<Actor | null>; // null if missing/expired/revoked or member removed or calendar deleted; slides expiry & updates last_active_at at most once per minute
revokeSession(db: Db, token: string): Promise<void>; revokeMemberSessions(db: Db, memberId: string): Promise<void>; revokeCalendarSessions(db: Db, calendarId: string): Promise<void>;
// policy.ts
type Action = 'calendar.update'|'calendar.delete'|'password.change'|'member.remove'|'invite.manage'|'event.create'|'event.update'|'event.delete'|'event.view';
authorize(actor: Actor, action: Action, ctx?: { settings?: { membersCanEditAll: boolean }; event?: { createdBy: string; memberId: string } }): void /* throws AppError FORBIDDEN */
```

- [ ] **Step 1: Policy test** `tests/unit/policy.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { authorize, type Actor } from '@/server/authz/policy';
const owner: Actor = { calendarId: 'c', memberId: 'o', role: 'owner' };
const mom: Actor = { calendarId: 'c', memberId: 'm', role: 'member' };
const ev = { createdBy: 'o', memberId: 'o' };
describe('authorize', () => {
  it('owner can do admin actions; member cannot', () => {
    for (const a of ['calendar.update', 'calendar.delete', 'password.change', 'member.remove', 'invite.manage'] as const) {
      expect(() => authorize(owner, a)).not.toThrow();
      expect(() => authorize(mom, a)).toThrow(/permission/i);
    }
  });
  it('member edits others events only if membersCanEditAll', () => {
    expect(() => authorize(mom, 'event.update', { settings: { membersCanEditAll: true }, event: ev })).not.toThrow();
    expect(() => authorize(mom, 'event.update', { settings: { membersCanEditAll: false }, event: ev })).toThrow();
  });
  it('member deletes only own events (created or assigned); owner deletes any', () => {
    expect(() => authorize(mom, 'event.delete', { event: ev })).toThrow();
    expect(() => authorize(mom, 'event.delete', { event: { createdBy: 'm', memberId: 'o' } })).not.toThrow();
    expect(() => authorize(mom, 'event.delete', { event: { createdBy: 'o', memberId: 'm' } })).not.toThrow();
    expect(() => authorize(owner, 'event.delete', { event: { createdBy: 'm', memberId: 'm' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Implement policy**

```ts
import { AppError } from '@/lib/errors';
export interface Actor { calendarId: string; memberId: string; role: 'owner' | 'member' }
export type Action = /* union above */;
const ADMIN: Action[] = ['calendar.update', 'calendar.delete', 'password.change', 'member.remove', 'invite.manage'];
export function authorize(actor: Actor, action: Action, ctx: { settings?: { membersCanEditAll: boolean }; event?: { createdBy: string; memberId: string } } = {}): void {
  const deny = () => { throw new AppError('FORBIDDEN', 'You do not have permission to do that'); };
  if (ADMIN.includes(action)) { if (actor.role !== 'owner') deny(); return; }
  if (actor.role === 'owner') return;
  const mine = ctx.event && (ctx.event.createdBy === actor.memberId || ctx.event.memberId === actor.memberId);
  if (action === 'event.update' && !mine && !(ctx.settings?.membersCanEditAll ?? true)) deny();
  if (action === 'event.delete' && !mine) deny();
}
```
- [ ] **Step 3: Run policy test** → PASS.
- [ ] **Step 4: Primitives integration test** `tests/integration/auth-primitives.test.ts` — with migrated test DB and a seeded calendar+owner (helper `seedCalendar(db)` inline: insert calendar, member, set owner):
  - `hashPassword` output starts with `$argon2id$`; `verifyPassword` true/false; hash differs per call.
  - Lockout: 4 `recordFailure(['cal:X','ip:1'])` → `assertNotLocked` passes; 5th → throws `RATE_LIMITED`; `clearFailures` resets; lock key independent (`['cal:Y']` not locked). After simulating time passing (update `locked_until` to past) → passes.
  - Session: `createSession` → `resolveSession(token)` returns Actor; DB row contains hash not token (`select token_hash` ≠ token); expired (`update expires_at = now()-1s`) → null; `revokeSession` → null; removing member (`removed_at=now()`) → null; calendar `deleted_at` set → null; `revokeMemberSessions` → null.
- [ ] **Step 5: Implement** (argon2 `hash` with default options from `@node-rs/argon2` which is argon2id; params `memoryCost: 19456, timeCost: 2, parallelism: 1`):

```ts
// password.ts
import { hash, verify } from '@node-rs/argon2';
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (p: string) => hash(p, OPTS);
export async function verifyPassword(h: string, p: string) { try { return await verify(h, p); } catch { return false; } }
let dummy: Promise<string> | undefined;
export async function verifyDummy(p: string) { dummy ??= hashPassword('dummy-password-for-timing'); await verifyPassword(await dummy, p); }
```
```ts
// tokens.ts
import { randomBytes, randomInt, createHash } from 'node:crypto';
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const newCalendarCode = () => Array.from({ length: 4 }, () => L[randomInt(L.length)]).join('') + '-' + String(randomInt(10000)).padStart(4, '0');
const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newRecoveryCode = () => [0, 1, 2].map(() => Array.from({ length: 4 }, () => A[randomInt(A.length)]).join('')).join('-');
```
  `lockout.ts`: table `auth_attempts(key pk, failures int, window_start, locked_until)`. `recordFailure`: for each key, `INSERT … ON CONFLICT (key) DO UPDATE SET failures = CASE WHEN window_start < now() - interval '15 minutes' THEN 1 ELSE auth_attempts.failures + 1 END, window_start = CASE WHEN … THEN now() ELSE auth_attempts.window_start END, locked_until = CASE WHEN new failures >= 5 THEN now() + least(interval '1 hour', interval '1 minute' * power(2, new_failures - 5)) ELSE locked_until END` (write with `db.execute(sql\`…\`)`; atomic so concurrent failures are counted). `assertNotLocked`: select `locked_until > now()` for any key → `throw new AppError('RATE_LIMITED','Too many attempts. Try again later.')`.
  `session.ts`: 30-day expiry; `resolveSession` joins sessions→members→calendars where `revoked_at is null and expires_at > now() and members.removed_at is null and calendars.deleted_at is null`; sliding update `expires_at = now()+30d` only if `expires_at < now()+29d`; update `members.last_active_at` only if older than 1 minute.
- [ ] **Step 6: Run** `npx vitest run tests/unit/policy.test.ts tests/integration/auth-primitives.test.ts` → PASS.
- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(auth): password hashing, tokens, lockout, sessions, authz policy"`

---

### Task 6: Calendar service (create, join, recover, settings, delete) + API wrapper + routes

**Files:**
- Create: `src/server/services/calendars.ts`, `src/server/api.ts`, `src/server/auth/request.ts`, `src/app/api/calendars/route.ts`, `src/app/api/auth/join/route.ts`, `src/app/api/auth/logout/route.ts`, `src/app/api/auth/me/route.ts`, `src/app/api/auth/recover/route.ts`, `src/app/api/calendar/route.ts`, `src/app/api/calendar/password/route.ts`, `src/app/api/health/route.ts`, `tests/integration/calendars.test.ts`, `tests/helpers/services.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5.
- Produces:
```ts
createCalendar(db, input: z.infer<typeof createCalendarSchema>, ctx:{ip:string; ua?:string}): Promise<{ calendar:{id;code;name;timezone}; member:MemberDTO; recoveryCode:string; sessionToken:string; sessionExpiresAt:Date }>
joinCalendar(db, input: z.infer<typeof joinSchema>, ctx): Promise<{ status:'joined'|'needs_confirmation'; calendar?; member?; sessionToken?; sessionExpiresAt? }>
getCalendar(db, actor): Promise<CalendarDTO & { me: MemberDTO }>
updateCalendar(db, actor, patch:{name?;timezone?;settings?:{membersCanEditAll?:boolean}}): Promise<CalendarDTO>
changePassword(db, actor, current:string, next:string): Promise<{recoveryCode?:never}>   // revokes OTHER sessions
recoverPassword(db, code:string, recoveryCode:string, newPassword:string, ctx): Promise<{ recoveryCode:string }>  // rotates; revokes ALL sessions
deleteCalendar(db, actor, confirmName:string): Promise<void>
type MemberDTO = { id; name; role; color; lastActiveAt: string|null }
type CalendarDTO = { id; code; name; timezone; settings:{membersCanEditAll:boolean}; createdAt; updatedAt }
// api.ts
api<T>(opts:{ auth: boolean; schema?: ZodType<T>; rateLimit?: number }, fn:(c:{ req:Request; actor: Actor|null; body:T; db:Db; ip:string; params:Record<string,string> }) => Promise<{status?:number; body?:unknown; setSession?:{token:string;expires:Date}; clearSession?:true}>): (req:Request, ctx:{params:Promise<Record<string,string>>}) => Promise<Response>
```
- Test helper `tests/helpers/services.ts`: `setup()` → `{ db, url }` (creates test db, migrates, `createDb`); `makeFamily(db)` → creates calendar via `createCalendar` (password `'correct horse'`) and returns `{ calendar, owner: Actor, ownerToken, recoveryCode }`; `joinAs(db, code, name)` → `Actor`.

- [ ] **Step 1: Failing tests** `tests/integration/calendars.test.ts` covering:
  1. `createCalendar` persists `password_hash` starting `$argon2id$` and never equals the password; code matches `/^[A-Z]{4}-\d{4}$/`; owner member role `owner`; `calendars.owner_member_id` set; returns `recoveryCode` and DB `recovery_hash` ≠ recovery code.
  2. `joinCalendar` correct password → `joined`, member role `member`; wrong password → `AppError` message exactly `Invalid calendar ID or password`; unknown code → same message (equal `.message` and `.code`).
  3. Lockout: 5 wrong joins on same code → 6th with **correct** password throws `RATE_LIMITED`.
  4. Join with existing name (different case `mom` vs `Mom`) without `confirmExisting` → `needs_confirmation`, no new member row; with `confirmExisting:true` → joined as the same member id.
  5. Concurrent joins: `Promise.all` of 5 joins as `"Sam"` with `confirmExisting:true` → exactly one `members` row named Sam, all five succeed with the same member id.
  6. Concurrent creates of 2 calendars never collide on code (retry on unique violation).
  7. `updateCalendar` by owner ok; by member → `FORBIDDEN`; invalid timezone → `VALIDATION` (via schema).
  8. `changePassword` wrong current → `FORBIDDEN`/`UNAUTHENTICATED` error; right current → old password no longer joins, new one does; other sessions revoked.
  9. `recoverPassword` with right recovery code rotates password, returns a new recovery code that differs, old recovery code fails, all sessions revoked; wrong recovery code counts toward lockout.
  10. `deleteCalendar` wrong confirm name → `VALIDATION`; right name by owner → rows gone from calendars/members/events/audit/sessions; by member → `FORBIDDEN`.
  11. Cross-calendar: `getCalendar` with an actor whose `calendarId` is calendar A never returns calendar B data (create two families, assert names).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement service.** Rules:
  - `createCalendar`: lockout-check key `ip:<ip>` is not applied (creation rate limited in `api()` by IP at 10/hour via `auth_attempts`-style key `create:<ip>` — implement as `recordFailure(db,[`create:${ip}`])` after each success and `assertNotLocked` before; threshold for this key is 5 per window, so reuse is OK for personal use; make threshold a parameter `recordFailure(db, keys, {max=5})` and use `max=10` for create).
  - One `db.transaction`: insert calendar (code retry loop up to 5 on `23505` unique violation of `calendars_code_unique`), insert owner member (`name_key = nameKey(name)`, color from palette by member index), `update calendars set owner_member_id`, create session. Palette: `['#2563eb','#db2777','#16a34a','#d97706','#7c3aed','#0891b2','#dc2626','#4b5563']`, color = palette[count % length].
  - `joinCalendar`: `assertNotLocked([cal:<code>, ip:<ip>])`; look up calendar (`deleted_at is null`); if none → `verifyDummy(password)`, `recordFailure`, throw generic error; if `!verifyPassword` → `recordFailure`, throw generic; on success `clearFailures([cal:<code>])` (keep ip key); find active member by `name_key`; if exists and not `confirmExisting` → return `needs_confirmation`; if exists → session for that member; else insert member with `ON CONFLICT (calendar_id, name_key) WHERE removed_at IS NULL DO NOTHING RETURNING`, if nothing returned re-select (race) and use that member — **but only auto-use when `confirmExisting` is true; otherwise return `needs_confirmation`**. Invite token (if given) must be valid (unexpired, unrevoked, `uses < max_uses`) and increments `uses` in the same transaction — add this in Task 7; here accept and ignore the field.
  - Generic error: `new AppError('UNAUTHENTICATED', 'Invalid calendar ID or password')`.
  - `recoverPassword`: same lockout/generic-error discipline with message `Invalid calendar ID or recovery code`; verify against `recovery_hash` using argon2.
  - `deleteCalendar`: `authorize(actor,'calendar.delete')`; compare `cleanText(confirmName) === calendar.name`; `delete from calendars where id=…` (cascades). Also `NOTIFY` via Task 9 later.
- [ ] **Step 4: Implement `api()` wrapper** `src/server/api.ts`:
```ts
import type { ZodType } from 'zod';
import { AppError } from '@/lib/errors';
import { getDb, type Db } from './db/client';
import { getEnv } from '@/config/env';
import { logger } from './logger';
import { readSessionToken, sessionCookie, clearedCookie, clientIp } from './auth/request';
import { resolveSession } from './auth/session';
import type { Actor } from './authz/policy';

type Result = { status?: number; body?: unknown; setSession?: { token: string; expires: Date }; clearSession?: true };
export function api<T = undefined>(
  opts: { auth: boolean; schema?: ZodType<T> },
  fn: (c: { req: Request; actor: Actor | null; body: T; db: Db; ip: string; params: Record<string, string> }) => Promise<Result>,
) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      const env = getEnv();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertSameOrigin(req, env.APP_ORIGIN);
      const db = getDb();
      const actor = opts.auth ? await requireActor(req, db) : await optionalActor(req, db);
      let body = undefined as T;
      if (opts.schema) {
        const raw = req.method === 'GET' || req.method === 'DELETE' ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => { throw new AppError('VALIDATION', 'Invalid JSON body'); });
        const r = opts.schema.safeParse(raw);
        if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        body = r.data;
      }
      const out = await fn({ req, actor, body, db, ip: clientIp(req, env.TRUST_PROXY), params: await ctx.params });
      const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (out.setSession) headers.append('set-cookie', sessionCookie(out.setSession.token, out.setSession.expires));
      if (out.clearSession) headers.append('set-cookie', clearedCookie());
      return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status ?? 200, headers });
    } catch (e) { return errorResponse(e); }
  };
}
function assertSameOrigin(req: Request, origin: string) {
  const o = req.headers.get('origin');
  if (!o || new URL(o).origin !== new URL(origin).origin || req.headers.get('x-requested-with') !== 'fetch') throw new AppError('FORBIDDEN', 'Cross-site request blocked');
}
function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  const dbDown = typeof e === 'object' && e !== null && 'code' in e && ['ECONNREFUSED', 'CONNECT_TIMEOUT', '57P01', '08006', '08001', 'CONNECTION_CLOSED'].includes(String((e as { code: unknown }).code));
  logger.error({ err: e instanceof Error ? { message: e.message, stack: e.stack } : e }, 'unhandled');
  return dbDown
    ? Response.json({ error: { code: 'UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' } }, { status: 503 })
    : Response.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, { status: 500 });
}
```
  `request.ts`: `readSessionToken(req)` parses cookie `fc_session`; `sessionCookie(token, expires)` → `fc_session=…; HttpOnly; SameSite=Lax; Path=/; Expires=…` (+`; Secure` in production); `clearedCookie()` with `Max-Age=0`; `clientIp(req, trustProxy)` uses first `x-forwarded-for` only when `trustProxy`, else `'unknown'` (documented: set `TRUST_PROXY=true` behind Caddy/Fly/Railway). `requireActor` throws `UNAUTHENTICATED 'Please sign in'`.
  Routes (each a 5–10 line file calling `api` + a service function, `export const runtime = 'nodejs'`): `POST /api/calendars` (schema `createCalendarSchema`; returns 201 `{calendar, member, recoveryCode}` + `setSession`), `POST /api/auth/join`, `POST /api/auth/logout` (revokes token, `clearSession`), `GET /api/auth/me` (auth required; returns `getCalendar`), `POST /api/auth/recover`, `GET|PATCH|DELETE /api/calendar`, `POST /api/calendar/password`, `GET /api/health` (runs `select 1`, 200 `{ok:true}` or 503).
- [ ] **Step 5: Run** `npx vitest run tests/integration/calendars.test.ts` → PASS; `npx tsc --noEmit` → PASS.
- [ ] **Step 6: API-level test** `tests/integration/api-calendars.test.ts`: import route handlers directly and call with `new Request('http://localhost:3000/api/calendars', {method:'POST', headers:{origin:'http://localhost:3000','x-requested-with':'fetch','content-type':'application/json'}, body})` with `DATABASE_URL`/`APP_ORIGIN` env set to test DB in `beforeAll` (reset env cache by running tests with `vi.resetModules()`); assert: 201 + `set-cookie` containing `HttpOnly`; request without Origin → 403; invalid JSON → 400; response body never contains `password` or hash strings; `GET /api/auth/me` with cookie → 200, without → 401.
- [ ] **Step 7: Commit** `git add -A && git commit -m "feat: calendar create/join/recover/settings/delete with API layer"`

---

### Task 7: Members and invites

**Files:**
- Create: `src/server/services/members.ts`, `src/server/services/invites.ts`, `src/app/api/members/route.ts`, `src/app/api/members/[id]/route.ts`, `src/app/api/invites/route.ts`, `src/app/api/invites/[id]/route.ts`, `src/app/api/join-info/route.ts`, `tests/integration/members-invites.test.ts`
- Modify: `src/server/services/calendars.ts` (honor `inviteToken` in `joinCalendar`)

**Interfaces:**
- Produces:
```ts
listMembers(db, actor): Promise<MemberDTO[]>   // active only; plus removed members' ids/names are exposed via events as "Former member"
removeMember(db, actor, memberId: string, opts: { eventsPolicy: 'keep' | 'delete' | { reassignTo: string } }): Promise<void>
createInvite(db, actor, opts:{ expiresInHours?: number /*default 168*/; maxUses?: number|null }): Promise<{ id; token; expiresAt: Date; maxUses: number|null }>   // token returned once
listInvites(db, actor): Promise<{ id; expiresAt; maxUses; uses; revokedAt }[]>
revokeInvite(db, actor, inviteId: string): Promise<void>
getJoinInfo(db, token: string): Promise<{ calendarName: string; code: string }>   // public; invalid/expired/revoked → NOT_FOUND 'Invite not found or expired'
```
- Invite URL format: `${APP_ORIGIN}/join?invite=<token>`; share text: `Join the <name> Family Calendar\nCalendar ID: <code>\n<url>` (built client-side; never includes password).

- [ ] **Step 1: Failing tests** covering:
  1. Owner removes member (`keep`): member `removed_at` set, member's events remain, member's session `resolveSession` → null immediately; same name can be rejoined as new member.
  2. `removeMember` `delete` soft-deletes that member's events (`deleted_at` set + audit rows); `reassignTo` moves events (`member_id` changes, `version` bumps, audit row `update`); reassign target from another calendar → `NOT_FOUND`; reassign to removed member → `VALIDATION`.
  3. Owner cannot remove self (`VALIDATION 'The owner cannot be removed'`); member cannot remove anyone (`FORBIDDEN`); removing a member id from another calendar → `NOT_FOUND`.
  4. Invites: create returns token; DB stores only hash; `getJoinInfo(token)` returns name+code only (assert no `password_hash` key); expired (`expires_at` in past), revoked, and exhausted (`uses >= max_uses`) → `NOT_FOUND`.
  5. `joinCalendar` with a valid `inviteToken` but wrong password → still fails (token never bypasses password); with right password increments `uses` exactly once; invite for calendar A used with calendar B's code → `NOT_FOUND`/generic failure and no `uses` increment.
  6. Member cannot create/revoke/list invites (`FORBIDDEN`); revoke another calendar's invite id → `NOT_FOUND`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `removeMember` in one transaction: `authorize(actor,'member.remove')`; select target `where id=? and calendar_id=actor.calendarId and removed_at is null` else `NOT_FOUND`; reject if `target.role==='owner'`; apply events policy (audit rows written via `writeAudit(tx, …)` from Task 8's `audit.ts` — **create `src/server/services/audit.ts` now** with `writeAudit(tx, {calendarId, eventId, action, actorMemberId, before, after})` and a unit-free use here); set `removed_at`; `update sessions set revoked_at=now() where member_id=?`. `createInvite`: `token=newToken()`, store `hashToken(token)`; `maxUses` 1–100 or null; `expiresInHours` 1–720. In `joinCalendar` when `inviteToken` present: after password verified, in the same transaction, `update invites set uses=uses+1 where token_hash=? and calendar_id=? and revoked_at is null and expires_at>now() and (max_uses is null or uses<max_uses) returning id` — zero rows → `NOT_FOUND 'Invite not found or expired'`. Routes: `GET /api/members`, `DELETE /api/members/:id` (body-less; `eventsPolicy` from query params `events=keep|delete|reassign&to=<uuid>`, validated by zod), `GET|POST /api/invites`, `DELETE /api/invites/:id`, `GET /api/join-info?token=` (`auth:false`; rate-limited by IP using `recordFailure` on lookup failures with key `invite:<ip>`).
- [ ] **Step 4: Run** tests → PASS; `npx vitest run` whole suite → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: member removal and invitations"`

---

### Task 8: Events service (CRUD, recurrence, audit, locking, idempotency, conflicts API)

**Files:**
- Create: `src/server/services/events.ts`, `src/server/services/conflicts.ts`, `src/app/api/events/route.ts`, `src/app/api/events/[id]/route.ts`, `src/app/api/events/[id]/history/route.ts`, `src/app/api/events/[id]/restore/route.ts`, `src/app/api/conflicts/route.ts`, `tests/integration/events.test.ts`
- Modify: `src/server/services/audit.ts` (add `listHistory`)

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 7.
- Produces:
```ts
type OccurrenceDTO = { eventId; memberId; memberName: string; memberRemoved: boolean; title; description: string|null; location: string|null; start: string /*ISO UTC*/; end: string; allDay: boolean; occurrenceDate: string; isRecurring: boolean; seriesId: string|null; version: number; createdBy: {id,name}; createdAt: string; updatedBy: {id,name}; updatedAt: string; recurrence: RecurrenceInput|null }
type ConflictDTO = { id: string; start: string; end: string; days: string[]; members: {id,name}[]; occurrences: {eventId,title,memberId,memberName,start,end}[]; overlaps: {aEventId,bEventId,start,end,sameMember:boolean,summary:string}[] }
createEvent(db, actor, input: EventInput, idempotencyKey?: string): Promise<OccurrenceDTO>        // first occurrence DTO
updateEvent(db, actor, id: string, patch: z.infer<typeof eventPatchSchema>): Promise<OccurrenceDTO>
deleteEvent(db, actor, id: string, opts:{ version:number; scope:'this'|'series'; occurrenceDate?:string }): Promise<void>
restoreEvent(db, actor, id: string): Promise<OccurrenceDTO>         // owner only
listEvents(db, actor, q:{ from:Date; to:Date; memberId?:string; search?:string }): Promise<{ occurrences: OccurrenceDTO[]; dayStatus: Record<string,'scheduled'|'conflict'>; conflicts: ConflictDTO[] }>
getEventHistory(db, actor, id): Promise<{ action; actorName; at: string; before: unknown; after: unknown }[]>
```
`summary` format: `"Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM."` (times in calendar tz, `h:mm a`; same-member: `"Dad is double-booked from … to …."`).

- [ ] **Step 1: Failing tests** `tests/integration/events.test.ts` (use `makeFamily`, `joinAs`):
  1. Create: persists UTC times (`Australia/Melbourne` 18:00 → 07:00Z), `created_by=updated_by=actor`, `version=1`, audit row `create` with `after` containing title and no `before`.
  2. Create for a `memberId` of another calendar → `VALIDATION`/`NOT_FOUND` (assert not 500 and no row); for a removed member → `VALIDATION`.
  3. Invalid: `end <= start` → `VALIDATION`; duration > 7 days → `VALIDATION`; end before start across midnight (`23:00`→`01:00` same date) → `VALIDATION`; start `2026-02-30T10:00` → `VALIDATION`.
  4. Midnight crossing allowed: `2026-10-10T23:00`→`2026-10-11T01:00` ok and appears in range queries for both days.
  5. Update: bumps `version`, sets `updated_by`/`updated_at`, keeps `created_by`; audit row has `before` and `after`; **stale version → `CONFLICT`** with message `This event was changed by someone else. Review the latest version.` and the row unchanged; two concurrent updates with the same version → exactly one succeeds (`Promise.allSettled`).
  6. Permissions: member updates another member's event when `membersCanEditAll=true` (default) ok; after `updateCalendar(... membersCanEditAll:false)` → `FORBIDDEN`; member deletes other's event → `FORBIDDEN`; own → ok; owner deletes any.
  7. Delete: soft delete (`deleted_at`), audit `delete`; deleted not in `listEvents`; second delete → `NOT_FOUND`; owner `restoreEvent` returns it to listings; member restore → `FORBIDDEN`.
  8. Cross-calendar: family B's actor `updateEvent/deleteEvent/getEventHistory/restoreEvent` on family A's event id → `NOT_FOUND`; `listEvents` for B never includes A's events.
  9. Idempotency: same `idempotencyKey` twice (and `Promise.all` of 5) → one `events` row, identical returned `eventId`; same key with different payload → `CONFLICT`.
  10. `listEvents` range filters (event ending exactly at `from` excluded; starting exactly at `to` excluded), `memberId` filter, `search` matches title or description case-insensitively (and `%`/`_` in the search are literals, not wildcards).
  11. Recurring: weekday series Mon–Fri expands correctly inside range; `updateEvent scope:'this'` with `occurrenceDate` adds exception to parent and creates a one-off event with `series_id`; `deleteEvent scope:'this'` adds exception only; `scope:'series'` soft-deletes parent. Series with `until` in the past of range yields none.
  12. Conflicts: Dad 10–12 vs Mom 11:30–13:00 → `dayStatus['2026-10-10']==='conflict'` and `conflicts[0].overlaps[0].summary === 'Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM.'`; touching events → `scheduled`; a recurring school series overlapping a one-off on one date marks only that date `conflict`; day with a single event → `scheduled`; empty day absent. Deleting one of the two events clears the conflict.
  13. Range > 366 days or `from>=to` rejected (`VALIDATION`) at the route/schema layer; expansion limit: a daily series queried over 366 days returns ≤ 2000 occurrences.
  14. History: `getEventHistory` returns chronological entries with actor names; entry for removed member's actions still shows name.
  15. Persistence: new `createDb(url)` connection sees events written by the first (data survives connections); a transaction that throws after inserting the event but before audit leaves **no** event row (rollback test by injecting a failing audit writer via `vi.spyOn`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `events.ts`:
  - All mutations in `db.transaction`. Load calendar (`timezone`, `settings`) once per call. Convert `input.start/end` via `toUtc(local, calendar.timezone)`; validate `end > start`, duration ≤ 7d, and that `DateTime.fromISO(start).isValid` (catches Feb 30). All-day: store `start=00:00` local, `end=start+1 day` (client sends date with `T00:00`/`T00:00` next day; server normalizes to start-of-day and `+1 day` if `end<=start`).
  - Member check: `select 1 from members where id=? and calendar_id=? and removed_at is null` else `VALIDATION 'Unknown family member'`.
  - Recurrence: `rrule = buildRRule(input.recurrence)`; store `local_start/local_end` (the input strings), `tz=calendar.timezone`, `recur_until` from `until` (end of day in tz) when given, `start_utc/end_utc` = first occurrence (so range index still works); `exceptions='[]'`.
  - Range queries: non-recurring `where calendar_id=? and deleted_at is null and rrule is null and start_utc < :to and end_utc > :from`; series `where calendar_id=? and rrule is not null and deleted_at is null and start_utc < :to and (recur_until is null or recur_until > :from)`, then `expandSeries` each (series count is bounded by calendar usage; total capped at 2000 via shared counter). Join `members` for names (include removed; `memberRemoved = removed_at is not null`, name shown as `"<name> (former member)"` in UI).
  - `search`: escape `\`, `%`, `_` and use `ilike ... escape '\'` on title/description (parameterized).
  - Update: `select … for update` row scoped by `calendar_id`; `authorize(actor,'event.update',{settings, event})`; version check → `CONFLICT`; `update … set version=version+1, updated_by, updated_at=now()`; `writeAudit` with before/after (snapshot of editable fields).
  - Idempotency: `INSERT INTO idempotency_keys(key,calendar_id,member_id,request_hash) ON CONFLICT DO NOTHING`; if inserted → proceed and store `response` at end of the transaction; else read existing row: if `request_hash` differs → `CONFLICT 'Idempotency key reuse with different data'`; if `response` null (in-flight; because the first transaction hasn't committed the row is invisible to others until commit, so concurrent callers block on the unique index until the first commits) → return stored response. `request_hash = sha256(JSON.stringify(input))`. Purge keys older than 24h opportunistically (`delete … where created_at < now()-interval '24 hours'` at 1% of calls).
  - `conflicts.ts` service: `buildConflictDTOs(groups, nameOf, tz)` creating summaries with Luxon `h:mm a` formatting.
  - Routes: `GET /api/events?from&to&member&q` (schema `rangeSchema.extend({member: z.string().uuid().optional(), q: z.string().max(100).optional()})`), `POST /api/events` (reads `Idempotency-Key` header), `PATCH/DELETE /api/events/:id` (DELETE takes `version`, `scope`, `occurrenceDate` as query params), `GET /api/events/:id/history`, `POST /api/events/:id/restore`, `GET /api/conflicts?from&to`. Validate `:id` is a UUID (invalid → 404).
- [ ] **Step 4: Run** `npx vitest run tests/integration/events.test.ts` → PASS, then whole suite → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: events CRUD with recurrence, conflicts, audit, locking, idempotency"`

---

### Task 9: Real-time (LISTEN/NOTIFY + SSE)

**Files:**
- Create: `src/server/realtime/notify.ts`, `src/server/realtime/hub.ts`, `src/app/api/stream/route.ts`, `tests/integration/realtime.test.ts`
- Modify: `src/server/services/events.ts`, `members.ts`, `calendars.ts`, `invites.ts` (call `notifyChange` after commit)

**Interfaces:**
- Produces:
```ts
notifyChange(sql: Sql, calendarId: string, change: { type: 'event' | 'member' | 'calendar' | 'deleted'; id?: string }): Promise<void>  // pg_notify('calendar_changes', json); payload < 8000 bytes
subscribe(calendarId: string, cb: (c: Change) => void): () => void   // unsubscribe fn
startHub(url: string): Promise<{ stop(): Promise<void> }>   // one dedicated LISTEN connection with reconnect+backoff
```
- SSE contract: `GET /api/stream` (auth required) → `text/event-stream`; sends `event: ready` on connect, `event: change` with `data: {"type":"event","id":"…"}`, and `: ping` comment every 25 s. Client reacts to any `change` by refetching current range.

- [ ] **Step 1: Failing test** — start hub on test DB; `subscribe(calA, cbA)` and `subscribe(calB, cbB)`; call `notifyChange(sql, calA, {type:'event', id:'1'})`; await `cbA` called once with `type:'event'`; `cbB` never called; unsubscribe stops delivery. Second test: `createEvent` via service then asserts `cbA` received a change (proves services notify; call `notifyChange` **after** transaction commit, not inside it, so listeners never refetch before data is visible). Third: terminate the hub's backend (`select pg_terminate_backend(pid) from pg_stat_activity where query like 'listen%'` or via application_name `fc-hub`) → hub reconnects and later notifications still arrive (poll up to 10 s).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `hub.ts` uses `postgres(url, {max:1, connection:{application_name:'fc-hub'}})` and `sql.listen('calendar_changes', onPayload, onListen)` — postgres.js re-establishes `listen` after reconnect automatically; wrap in try/catch with exponential backoff on initial failure. Hub keeps `Map<calendarId, Set<cb>>`. A process-level singleton `ensureHub()` lazily starts it from `getEnv().DATABASE_URL` the first time `/api/stream` is hit. SSE route: `ReadableStream` that registers `subscribe(actor.calendarId, …)`, writes `event: ready`, heartbeat via `setInterval`, and cleans up on `req.signal` abort. Headers: `content-type: text/event-stream; cache-control: no-store, no-transform; connection: keep-alive; x-accel-buffering: no`. Limit 20 concurrent streams per member (counter in hub; excess → close oldest).
- [ ] **Step 4: Wire `notifyChange`** after each committed mutation (event create/update/delete/restore → `{type:'event', id}`; member join/remove → `{type:'member'}`; calendar update → `{type:'calendar'}`; calendar delete → `{type:'deleted'}` and the SSE route then closes streams for that calendar).
- [ ] **Step 5: Run** `npx vitest run tests/integration/realtime.test.ts` → PASS; full suite → PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: realtime sync via LISTEN/NOTIFY and SSE"`

---

### Task 10: Security hardening (headers, CSP, IP rate limits, cross-tenant sweep)

**Files:**
- Create: `src/middleware.ts`, `src/server/security-headers.ts`, `tests/integration/security.test.ts`
- Modify: `next.config.ts`, `src/server/api.ts` (general rate limit)

**Interfaces:**
- Produces: `securityHeaders(nonce: string, isProd: boolean): Record<string,string>`; `middleware` sets a per-request CSP nonce and header set on all responses.

- [ ] **Step 1: Failing tests** `tests/integration/security.test.ts`:
  - `securityHeaders('abc', true)` includes: `Content-Security-Policy` containing `default-src 'self'`, `script-src 'self' 'nonce-abc'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; `Strict-Transport-Security: max-age=63072000; includeSubDomains`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` disabling camera/microphone/geolocation; non-prod omits HSTS.
  - **Tenant sweep:** parametrized over every authenticated route handler (events list/get/patch/delete/history/restore, members delete, invites delete) using family A actor's cookie against family B resource ids → every response is 404 (never 200/403 revealing existence, never 500).
  - Unauthenticated sweep: every `auth:true` route returns 401 with no cookie and with a garbage cookie.
  - CSRF sweep: every mutating route returns 403 when `Origin` is missing or foreign, and when `X-Requested-With` is missing.
  - Logging: after a failed join with password `hunter2hunter2`, captured pino output (stub `logger` destination) never contains the password; response bodies of create/join never contain `password_hash`/`recovery_hash`/`$argon2`.
  - Rate limit: 130 GETs in a minute from one session → 429 (limit 120/min per session/IP using in-memory token bucket in `api.ts`; document that multi-instance deployments should rely on lockout table + proxy limits).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** headers in `security-headers.ts`, nonce middleware in `src/middleware.ts` (generate `crypto.randomUUID()` base64 nonce, set `x-nonce` request header for the layout to attach to inline scripts, apply headers), `next.config.ts` `poweredByHeader:false`. Add token bucket (`Map<string,{tokens,updated}>`, key = session actor id or IP) in `api()`; when exceeded throw `RATE_LIMITED`. In dev, CSP `script-src` additionally allows `'unsafe-eval'` (Next HMR) — only when `NODE_ENV!=='production'`.
- [ ] **Step 4: Run** security tests → PASS; full suite → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(security): headers, CSP nonce, rate limiting, tenant/CSRF/auth sweeps"`

---

### Task 11: Frontend foundation, landing, create and join flows

**Files:**
- Create: `src/app/globals.css`, `src/lib/client/api.ts`, `src/components/ui/{Button,Field,Dialog,Toast}.tsx`, `src/app/page.tsx` (landing), `src/app/create/page.tsx`, `src/app/join/page.tsx`, `src/components/CreateCalendarForm.tsx`, `src/components/JoinCalendarForm.tsx`, `src/components/RecoveryCodePanel.tsx`, `tests/unit/client-api.test.ts`

**Interfaces:**
- Produces: `apiFetch<T>(path, {method?, body?, idempotencyKey?}): Promise<T>` — always sends `X-Requested-With: fetch`, `credentials:'same-origin'`; throws `ApiError {code, status, message}`; network failure throws `ApiError {code:'NETWORK', message:'Cannot reach the server. Check your connection and try again.'}`; retries GETs once on network failure.

- [ ] **Step 1: Failing unit test** for `apiFetch` with stubbed `fetch`: sets header, parses `{error:{code,message}}` into `ApiError`, maps rejected fetch to `NETWORK`, GET retried once, POST not retried.
- [ ] **Step 2: Implement** `apiFetch`, UI primitives (accessible: labels via `<label htmlFor>`, `aria-live` toasts, focus-trapped `<dialog>`), CSS variables with light/dark `prefers-color-scheme`, system font stack, 44px minimum touch targets, `:focus-visible` outlines.
- [ ] **Step 3: Landing page:** two large buttons "Create Family Calendar" → `/create`, "Join Family Calendar" → `/join`; if `GET /api/auth/me` succeeds redirect to `/calendar`.
- [ ] **Step 4: Create form** (family name, your name, password with show/hide toggle + confirm, timezone `<select>` of `Intl.supportedValuesOf('timeZone')` defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone`). Submit button disabled while pending (prevents double submit). On 201 show success panel: **Calendar ID** (large, copy button), share text (copy/share via `navigator.share` when available), and `RecoveryCodePanel` — recovery code shown once with a required checkbox "I saved my recovery code" before the "Open calendar" button enables. Password is never shown again.
- [ ] **Step 5: Join form:** fields Calendar ID (auto-uppercase, accepts `?code=`), Your name, Password; reads `?invite=<token>` → calls `GET /api/join-info` to display "Join the <name> Family Calendar" and prefill/lock Calendar ID. On `needs_confirmation` show dialog "A member named Mom already exists. Is this you?" with **Yes, that's me** (resubmits with `confirmExisting:true`) and **No, use a different name**. 429 shows "Too many attempts. Try again in a few minutes."; 401 shows the generic message; field-level validation errors inline with `aria-describedby`.
- [ ] **Step 6: Run** `npx vitest run tests/unit/client-api.test.ts` → PASS; `npm run build` → success.
- [ ] **Step 7: Manual check:** start dev server (Task 13's `scripts/dev.ts` may not exist yet — use `DATABASE_URL` pointing to an embedded PG started via a small `scripts/dev.ts`, **create it now**: starts `embedded-postgres` with persistent dir `.data/pg`, runs `runMigrations`, sets env, spawns `next dev`). Use browser tools to create a calendar and join in a second private context; confirm cookies set and recovery flow shown. Record result in the commit message.
- [ ] **Step 8: Commit** `git add -A && git commit -m "feat(ui): landing, create and join flows"`

---

### Task 12: Dashboard — calendar views, panels, day sheet, event form, settings

**Files:**
- Create: `src/app/calendar/page.tsx`, `src/components/calendar/{CalendarShell,MonthView,WeekView,DayView,DayStatusBadge,EventCard,EventForm,DaySheet,TodayPanel,UpcomingPanel,ConflictsPanel,MemberFilter,SearchBox,HistoryPopover,MembersDialog,SettingsDialog,InviteDialog}.tsx`, `src/lib/client/{useCalendarData,useRealtime,dateUtils}.ts`, `tests/unit/dateUtils.test.ts`

**Interfaces:**
- Consumes: all API routes. `useCalendarData({view, anchor, memberId, search})` → `{occurrences, dayStatus, conflicts, me, calendar, members, status:'loading'|'ready'|'offline'|'error', refetch()}`; `useRealtime(onChange)` opens `EventSource('/api/stream')`, on `change` calls `onChange` (debounced 250 ms), on error falls back to refetch on `visibilitychange`, `online`, and every 60 s until reconnect.
- `dateUtils`: `monthGrid(anchor: string, tz: string): string[][]` (6×7 of `YYYY-MM-DD`, weeks start Monday), `weekDays(anchor, tz): string[]`, `rangeFor(view, anchor, tz): {from: Date; to: Date}`, `shift(view, anchor, dir: -1|1): string`, `today(tz): string`.

- [ ] **Step 1: Failing unit test** `tests/unit/dateUtils.test.ts`: `monthGrid('2026-10-15','UTC')` is 6 rows × 7, first cell `2026-09-28` (Monday), contains `2026-10-31`; `weekDays('2026-10-15','UTC')[0]==='2026-10-12'`; `rangeFor('month', …)` covers the whole grid; `shift('month','2026-10-15',1)==='2026-11-15'`; `shift('week','2026-10-15',-1)==='2026-10-08'`; `today('Australia/Melbourne')` formats `YYYY-MM-DD`.
- [ ] **Step 2: Implement `dateUtils`** with Luxon (week start Monday: `startOf('week')` in Luxon is Monday), run test → PASS.
- [ ] **Step 3: Data hooks + shell.** `CalendarShell`: header (family name, current member chip, Members, Invite, Settings; owner-only items hidden for members), toolbar (Prev/Next, **Today**, view switcher Month/Week/Day as `role=tablist`, `MemberFilter` chips "Everyone | <names>", `SearchBox`), main grid, side panels (Today's Schedule, Upcoming next 7 days, Conflicts "⚠ N scheduling conflicts this week" button opening a list; each conflict item shows the `summary` and jump-to-day). Status banner when offline: "You're offline. Showing last loaded data. Retrying…" with Retry button.
- [ ] **Step 4: Views.** `MonthView`: 7-column grid; each cell shows day number, today ring, and status indicator: scheduled → green dot + text "N events" (visually-hidden "Scheduled" label on mobile), conflict → red ⚠ icon + "Conflict" label, empty → none. Cell `aria-label="October 10, 2 events, conflict"`. Event chips colored by member color with member initial. On viewports < 640 px chips collapse to up to 3 colored dots + status icon, and tapping a cell opens `DaySheet`. `WeekView`: 7 day columns on ≥ 768 px, vertical agenda list on mobile; `DayView`: hour grid 6:00–23:00 with overlapping events side by side and a red conflict bracket; Today line. Keyboard: arrow keys move focus between month cells, Enter opens day.
- [ ] **Step 5: DaySheet** (dialog on desktop, bottom sheet on mobile): date heading, status badge, chronological list of `EventCard`s (time range in calendar tz, title, member with color, comment, location, "Last edited by X" + `HistoryPopover` fetching `/api/events/:id/history` rendering "Created by Oybek — Oct 7, 8:32 PM / Edited by Mom — Oct 8, 9:15 AM"), conflict banner "⚠ Schedule Conflict — Dad and Mom have overlapping schedules from 11:30 AM to 12:00 PM." for each conflict that includes the day, and **Add event** button. Edit/Delete buttons shown according to permissions (mirror `authorize` client-side as hint only; server decides). Delete uses confirm dialog; recurring events ask "This occurrence / Entire series".
- [ ] **Step 6: EventForm:** title, member select (defaults to me), date, all-day toggle, start/end time (end defaults start+1h; overnight allowed with inline hint "Ends next day"), location, description, repeat select (Does not repeat / Every day / Every weekday / Every week / Every month / Custom → interval + weekday toggles + ends: never/on date/after N), generates `Idempotency-Key` via `crypto.randomUUID()` once per form open; submit disabled while pending; on `CONFLICT` (409 version) shows dialog "This event was changed by <name>. Review the latest version" with **Reload latest** (replaces form values with server version, keeps user's text in a "your changes" disclosure); on `NETWORK` shows inline retry preserving all input; on 429/503 shows the server message. Optimistic UI is **not** used for writes (server is source of truth); after success call `refetch()`.
- [ ] **Step 7: Dialogs.** `MembersDialog`: list with role badges, owner-only "Remove" → confirm dialog with radio (keep events / delete events / reassign to <member select>). `InviteDialog`: create invite (expiry 1 day/7 days/30 days, max uses), shows link + share text (no password) with copy button, list existing invites with Revoke. `SettingsDialog`: calendar name, timezone, toggle "Members can edit others' events", change password (current + new), danger zone: delete calendar requiring typing the calendar name; Sign out button.
- [ ] **Step 8: Verify in browser** (dev server): create family, join as two members in two browser contexts, add overlapping events → red conflict date with ⚠ and text; add touching events → green; edit in context B and see context A update without refresh (realtime); resize to 375×812 and confirm no horizontal scroll, bottom sheet works; offline (disable network via devtools/emulation) shows banner and form keeps input. Take screenshots and note any defect, then fix.
- [ ] **Step 9: Run** `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build` → all pass.
- [ ] **Step 10: Commit** `git add -A && git commit -m "feat(ui): calendar dashboard, views, event editing, settings, invites"`

---

### Task 13: End-to-end tests (Playwright)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/helpers.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/calendar.spec.ts`, `tests/e2e/responsive.spec.ts`, `scripts/e2e-server.ts`

**Interfaces:**
- `scripts/e2e-server.ts`: boots a fresh embedded Postgres on a random port, migrates, then runs `next build && next start` (or `next dev`) with `DATABASE_URL`, `APP_ORIGIN=http://localhost:3100`, `PORT=3100`. Playwright `webServer` runs it. Projects: `desktop` (1280×800) and `mobile` (iPhone 13 / Pixel 7 emulation).

- [ ] **Step 1: Install browsers:** `npx playwright install chromium`. If download fails, write specs anyway and report not run.
- [ ] **Step 2: Specs.**
  - `auth.spec.ts`: create calendar → recovery code gating (button disabled until checkbox); second context joins with code+password; wrong password shows `Invalid calendar ID or password`; 6 wrong attempts show the lockout message; invite link prefill.
  - `calendar.spec.ts`: create event "Gym" 6–7:30 PM for Oybek → appears in month cell (green ● + "scheduled" text), day sheet shows "Last edited by Oybek"; second member edits → "Last edited by Mom" and first context updates without reload; Dad 10–12 and Mom 11–1 → cell shows ⚠ "Conflict" and day sheet shows the summary text; touching events do not show conflict; delete asks for confirmation; filter by member hides others; search by title; month/week/day navigation + Today button; recurring weekday event appears on Mon–Fri only; refresh page → data persists.
  - `responsive.spec.ts` (mobile project): no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), tap date opens bottom sheet, add-event form usable, all primary buttons ≥ 44 px tall (assert bounding boxes), status icons visible without color (assert presence of ⚠ text/`aria-label`).
- [ ] **Step 3: Run** `npx playwright test` → PASS on both projects; fix real defects found (do not weaken assertions).
- [ ] **Step 4: Commit** `git add -A && git commit -m "test(e2e): playwright flows for desktop and mobile"`

---

### Task 14: Production ops, backups, docs

**Files:**
- Create: `ops/Dockerfile`, `ops/docker-compose.yml`, `ops/Caddyfile`, `ops/backup.sh`, `ops/restore.sh`, `ops/RESTORE.md`, `docs/DEPLOY.md`, `docs/SECURITY_CHECKLIST.md`, `.dockerignore`, `README.md`, `.github/workflows/ci.yml`
- Modify: `next.config.ts` (`output: 'standalone'`)

- [ ] **Step 1: Dockerfile** multi-stage (`node:22-alpine`): deps → build (`next build`) → runtime as non-root user, copies `.next/standalone`, `.next/static`, `public`, `src/server/db/migrations`, and a compiled `migrate` entry (`npx tsx` is dev-only; for runtime provide `scripts/migrate-prod.mjs` which uses `drizzle-orm/postgres-js/migrator` directly with `process.env.DATABASE_URL`). `HEALTHCHECK` hits `/api/health`.
- [ ] **Step 2: docker-compose.yml:** services `db` (postgres:16, volume, healthcheck), `migrate` (one-shot, `depends_on: db healthy`, runs `node scripts/migrate-prod.mjs`), `app` (depends on migrate completed; env from `.env`; `TRUST_PROXY=true`), `caddy` (HTTPS auto-certs; `Caddyfile` reverse-proxies to `app:3000`, disables response buffering for `/api/stream` via `flush_interval -1`), `backup` (postgres:16 image + cron loop calling `ops/backup.sh`).
- [ ] **Step 3: `ops/backup.sh`:** `pg_dump -Fc "$DATABASE_URL" > backups/fc-$(date -u +%Y%m%dT%H%M%SZ).dump`; verify with `pg_restore --list` (non-zero exit → fail loudly); optional upload when `S3_ENDPOINT`/`S3_BUCKET` set (via `aws s3 cp --endpoint-url`); retention: keep last 30 daily files and the first dump of each of the last 12 months, delete the rest; log each step with timestamps. `ops/restore.sh <dump>`: refuses to run without `--yes`; creates `fc_restore_check` DB, `pg_restore --no-owner --clean --if-exists`, prints row counts for calendars/members/events, and with `--into-production` restores to `$DATABASE_URL` after stopping app instructions printed.
- [ ] **Step 4: `ops/RESTORE.md`:** step-by-step recovery (stop app, take safety dump of current state, restore chosen dump into a scratch DB, verify counts, swap/restore into production, run `npm run db:migrate`, start app, verify `/api/health`), PITR notes for managed providers, **quarterly restore drill checklist**, RPO/RTO statement (nightly dump ⇒ RPO ≤ 24 h; PITR ⇒ minutes).
- [ ] **Step 5: `docs/DEPLOY.md`:** env var table (`DATABASE_URL`, `APP_ORIGIN` (https), `TRUST_PROXY`, `LOG_LEVEL`, `PORT`), option A: Railway/Fly.io + managed Postgres (build from `ops/Dockerfile`, release command `node scripts/migrate-prod.mjs`, health check `/api/health`, set `TRUST_PROXY=true`, single or multiple instances OK because of LISTEN/NOTIFY, requires long-lived connections so not serverless); option B: compose on a VPS with Caddy; migration strategy (forward-only, expand/contract, run before new version receives traffic, take a backup first); monitoring recommendations (uptime on `/api/health`, Sentry or log-based alert on `level>=error`, Postgres disk/connections/replication alerts, backup-age alert); log handling (pino JSON to stdout; redaction list).
- [ ] **Step 6: `docs/SECURITY_CHECKLIST.md`:** checklist with checkboxes mapped to controls and the test that proves each (argon2id hashing → `calendars.test.ts`; tenant isolation → `security.test.ts` sweep; CSRF → sweep; headers/CSP → `security.test.ts`; lockout → `auth-primitives.test.ts`; no secrets in client bundle → run `grep -r "DATABASE_URL" .next/static` returns nothing, include as CI step; HTTPS/HSTS; backups verified; dependency audit `npm audit --omit=dev`).
- [ ] **Step 7: CI** `.github/workflows/ci.yml`: Postgres 16 service; `npm ci`, `typecheck`, `lint`, `vitest run` with `TEST_DATABASE_URL_BASE=postgres://postgres:postgres@localhost:5432`, `npm run build`, grep guard against secrets in `.next/static`, `npx playwright install --with-deps chromium && npm run test:e2e`.
- [ ] **Step 8: `README.md`:** quickstart (`npm install`, `npm run dev` which boots embedded Postgres), commands, architecture overview, links to docs.
- [ ] **Step 9: Verify what can be verified locally:** `npm run build` succeeds with `output: 'standalone'`; run `bash -n ops/backup.sh ops/restore.sh` for syntax; if `docker` is unavailable (it is on this machine) state clearly that Docker/compose files were not executed; if a `pg_dump` binary exists in the embedded-postgres package directory, run `backup.sh` against the dev DB and `restore.sh` into a scratch DB as a real drill and record the row-count output in `ops/RESTORE.md` under "Verified on".
- [ ] **Step 10: Final verification** (superpowers:verification-before-completion): `npm run typecheck && npm run lint && npx vitest run && npm run build` and `npx playwright test`; paste actual outputs into the final report; list anything not run.
- [ ] **Step 11: Commit** `git add -A && git commit -m "chore: production deployment, backups, docs, CI"`

---

## Self-Review

**Spec coverage:** §2 stack → T1; §3 layering → File Structure; §4 schema → T2; §5 auth/authz/recovery/invites/lockout → T5–T7; §6 events/time/recurrence incl. scopes → T3, T4, T8; §7 conflicts → T4, T8; §8 concurrency (version, idempotency, transactions, member removal, soft delete, calendar delete, failure handling) → T6–T8, T11–T12; §9 realtime → T9, T12; §10 API → T6–T9 (all listed routes present: calendars, auth/join|logout|me|recover, calendar, calendar/password, members, invites, join-info, events, history, restore, conflicts, stream, health); §11 security → T6 (CSRF), T10; §12 UI → T11–T12; §13 notification-ready bus → **gap:** add a tiny `src/server/events-bus.ts` (`emitDomainEvent(name, payload)` with in-process subscriber list, realtime `notifyChange` registered as the sole subscriber) — included in Task 9 Step 4 below; §14 tests → every task + T13; §15 ops → T14.
**Placeholder scan:** none intentionally left; implementer-judgement spots (UI styling, route boilerplate) specify exact behavior and acceptance checks.
**Type consistency:** `Actor`, `Occurrence`, `EventInput`, `RecurrenceInput`, `OccurrenceDTO`, `ConflictDTO`, `MemberDTO` names are used identically across tasks; `authorize` signature fixed in T5; `notifyChange` signature fixed in T9.

**Task 9, Step 4 addendum (domain event bus):** create `src/server/events-bus.ts` exporting `type DomainEvent = 'event.created'|'event.updated'|'event.deleted'|'conflict.detected'` and `emitDomainEvent(name: DomainEvent, payload: {calendarId: string; eventId?: string})`/`onDomainEvent(cb)`. Services call `emitDomainEvent` after commit; a single subscriber registered in `realtime/notify.ts` translates to `notifyChange`. Add a unit test that subscribers receive emitted events and a throwing subscriber never breaks the emitter. `conflict.detected` is emitted by `createEvent/updateEvent` when the affected day's conflict set is non-empty after the write (computed with the same `listEvents` logic over the event's days) — this is the hook future reminder/email notifications attach to.
