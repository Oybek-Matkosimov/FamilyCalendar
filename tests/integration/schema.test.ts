import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, stopTestServer } from '../helpers/db';
import { runMigrations } from '@/server/db/migrate';

let sql: postgres.Sql; let url: string;
beforeAll(async () => { ({ url } = await createTestDb()); await runMigrations(url); sql = postgres(url); });
afterAll(async () => { await sql.end(); await stopTestServer(); });

let n = 1000;
const cal = () => sql`insert into calendars (code,name,password_hash,recovery_hash,timezone) values (${'ABCD-' + n++},'F','h','r','UTC') returning id`;
const mem = (c: string, name: string, role = 'member') =>
  sql`insert into members (calendar_id,name,name_key,role,color) values (${c},${name},${name.toLowerCase()},${role},'#fff') returning id`;
const evt = (c: string, m: string, interval: string) =>
  sql.unsafe(`insert into events (calendar_id,member_id,title,start_utc,end_utc,tz,created_by,updated_by)
    values ('${c}','${m}','x',now(),now()+interval '${interval}','UTC','${m}','${m}') returning id`);

describe('schema', () => {
  it('migrations are idempotent', async () => { await runMigrations(url); });

  it('rejects event whose member belongs to another calendar', async () => {
    const [a] = await cal(); const [b] = await cal();
    const [m] = await mem(a!.id, 'Mom');
    await expect(evt(b!.id, m!.id, '1 hour')).rejects.toThrow();
  });

  it('rejects end <= start and durations over 7 days', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Dad');
    await expect(evt(a!.id, m!.id, '0 hours')).rejects.toThrow();
    await expect(evt(a!.id, m!.id, '8 days')).rejects.toThrow();
    await evt(a!.id, m!.id, '1 hour');
  });

  it('enforces unique active member name per calendar via name_key', async () => {
    const [a] = await cal(); await mem(a!.id, 'Mom');
    await expect(mem(a!.id, 'MOM')).rejects.toThrow();
  });

  it('allows reuse of a name after removal', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Kid');
    await sql`update members set removed_at = now() where id = ${m!.id}`;
    await mem(a!.id, 'Kid');
  });

  it('cascades calendar deletion to members, events, audit and sessions', async () => {
    const [a] = await cal(); const [m] = await mem(a!.id, 'Z');
    const [e] = await evt(a!.id, m!.id, '1 hour');
    await sql`insert into event_audit (calendar_id,event_id,action,actor_member_id) values (${a!.id},${e!.id},'create',${m!.id})`;
    await sql`insert into sessions (token_hash,calendar_id,member_id,expires_at) values ('t' || ${a!.id},${a!.id},${m!.id},now()+interval '1 day')`;
    await sql`delete from calendars where id = ${a!.id}`;
    for (const t of ['events', 'event_audit', 'members', 'sessions']) {
      expect((await sql.unsafe(`select 1 from ${t} where calendar_id='${a!.id}'`)).length).toBe(0);
    }
  });

  it('owner_member_id must reference an existing member', async () => {
    await expect(sql`insert into calendars (code,name,password_hash,recovery_hash,timezone,owner_member_id)
      values ('ZZZZ-0001','F','h','r','UTC',gen_random_uuid())`).rejects.toThrow();
  });
});
