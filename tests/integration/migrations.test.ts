import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

afterAll(stopTestServer);

describe('migrations', () => {
  it('applies cleanly from an empty database and creates every table', async () => {
    const { url } = await createTestDb();
    await runMigrations(url);
    const sql = postgres(url, { max: 1 });
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    await sql.end();
    const names = rows.map((r) => r.table_name);
    for (const t of ['calendars', 'members', 'sessions', 'events', 'event_audit', 'invites', 'auth_attempts', 'idempotency_keys']) {
      expect(names).toContain(t);
    }
  });

  it('is safe when several app instances start at once (advisory lock)', async () => {
    const { url } = await createTestDb();
    await expect(Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)])).resolves.toBeDefined();
    const sql = postgres(url, { max: 1 });
    const counted = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await sql.end();
    expect(counted[0]!.n).toBe(3); // one row per migration file, no duplicates
  });

  it('creates the indexes the queries rely on', async () => {
    const { url } = await createTestDb();
    await runMigrations(url);
    const sql = postgres(url, { max: 1 });
    const rows = await sql`select indexname from pg_indexes where schemaname = 'public'`;
    await sql.end();
    const names = rows.map((r) => r.indexname);
    for (const i of ['events_range_idx', 'events_member_idx', 'members_active_name_uq', 'event_audit_event_idx', 'sessions_member_idx']) {
      expect(names).toContain(i);
    }
  });
});
