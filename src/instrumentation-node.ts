import { getEnv } from '@/config/env';
import { runMigrations } from '@/server/db/migrate';

/** Node-only start-up work: validate configuration (fail fast) and optionally migrate the database. */
export async function startup() {
  const env = getEnv();
  if (process.env.AUTO_MIGRATE === 'true') await runMigrations(env.DATABASE_URL);
}
