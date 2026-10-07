import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { createDb } from './client';

// Arbitrary constant: all instances of this app contend on the same advisory lock while migrating.
const MIGRATION_LOCK_ID = 727274;

/**
 * Applies pending SQL migrations (forward-only). Safe to call from several instances at once:
 * a session-level advisory lock serialises them and already-applied migrations are skipped.
 */
export async function runMigrations(url: string) {
  const { db, sql } = createDb(url, 2);
  try {
    const lock = await sql.reserve();
    try {
      await lock`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
      await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src/server/db/migrations') });
    } finally {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => {});
      lock.release();
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations(process.env.DATABASE_URL ?? '').then(
    () => { console.log('migrated'); process.exit(0); },
    (e) => { console.error(e); process.exit(1); },
  );
}
