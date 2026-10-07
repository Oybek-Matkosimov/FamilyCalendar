import { sql } from 'drizzle-orm';
import type { DbLike } from '@/server/db/client';
import { logger } from '@/server/logger';
import type { Change } from './hub';

export const CHANNEL = 'calendar_changes';

/** Send a change notification to every server process listening (including this one). Payload stays tiny. */
export async function notifyChange(db: DbLike, calendarId: string, change: Change): Promise<void> {
  const payload = JSON.stringify({ c: calendarId, t: change.type, i: change.id });
  await db.execute(sql`select pg_notify(${CHANNEL}, ${payload})`);
}

/** Call AFTER the transaction committed. A notification failure must never fail the user's request. */
export async function publishChange(db: DbLike, calendarId: string, change: Change): Promise<void> {
  try {
    await notifyChange(db, calendarId, change);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'realtime notify failed');
  }
}
