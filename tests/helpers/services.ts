import { randomInt } from 'node:crypto';
import { createTestDb } from './db';
import { runMigrations } from '@/server/db/migrate';
import { createDb, type Db } from '@/server/db/client';
import { createCalendar, joinCalendar } from '@/server/services/calendars';
import { resolveSession } from '@/server/auth/session';
import type { Actor } from '@/server/authz/policy';

export const PASSWORD = 'correct horse';
export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;

export async function setup() {
  const { url } = await createTestDb();
  await runMigrations(url);
  const { db, sql } = createDb(url, 8);
  return { db, sql, url, close: () => sql.end() };
}

export async function makeFamily(db: Db, over: { familyName?: string; memberName?: string; timezone?: string } = {}) {
  const r = await createCalendar(
    db,
    { familyName: over.familyName ?? 'Matkosimov', memberName: over.memberName ?? 'Oybek', password: PASSWORD, timezone: over.timezone ?? 'Australia/Melbourne' },
    { ip: randomIp() },
  );
  const owner = (await resolveSession(db, r.sessionToken))!;
  return { calendar: r.calendar, code: r.calendar.code, owner, ownerToken: r.sessionToken, recoveryCode: r.recoveryCode };
}

export async function joinAs(db: Db, code: string, name: string, password = PASSWORD): Promise<Actor> {
  const r = await joinCalendar(db, { code, memberName: name, password, confirmExisting: true }, { ip: randomIp() });
  if (r.status !== 'joined' || !r.sessionToken) throw new Error('join failed in test helper');
  return (await resolveSession(db, r.sessionToken))!;
}
