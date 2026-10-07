import { inArray, sql } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { authAttempts } from '@/server/db/schema';
import { AppError } from '@/lib/errors';

/** Throws RATE_LIMITED if any key is currently locked. */
export async function assertNotLocked(db: Db, keys: string[]): Promise<void> {
  const rows = await db
    .select({ key: authAttempts.key })
    .from(authAttempts)
    .where(sql`${inArray(authAttempts.key, keys)} and ${authAttempts.lockedUntil} > now()`);
  if (rows.length > 0) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
}

/**
 * Atomically count a failure per key. After `max` failures the key locks with exponential backoff (1 min, 2 min,
 * 4 min ... capped at 1 hour). The count is forgotten only after 15 quiet minutes: `window_start` is the time of the
 * most recent failure, so someone who keeps guessing keeps escalating instead of getting a fresh start.
 */
export async function recordFailure(db: Db, keys: string[], opts: { max?: number } = {}): Promise<void> {
  const max = opts.max ?? 5;
  for (const key of keys) {
    await db.execute(sql`
      insert into auth_attempts (key, failures, window_start)
      values (${key}, 1, now())
      on conflict (key) do update set
        failures = case when auth_attempts.window_start < now() - interval '15 minutes' then 1 else auth_attempts.failures + 1 end,
        window_start = now(),
        locked_until = case
          when (case when auth_attempts.window_start < now() - interval '15 minutes' then 1 else auth_attempts.failures + 1 end) >= ${max}::int
          then now() + least(interval '1 hour', interval '1 minute' * least(power(2, (case when auth_attempts.window_start < now() - interval '15 minutes' then 1 else auth_attempts.failures + 1 end) - ${max}::int), 64))
          else auth_attempts.locked_until end
    `);
  }
}

export async function clearFailures(db: Db, keys: string[]): Promise<void> {
  await db.delete(authAttempts).where(inArray(authAttempts.key, keys));
}
