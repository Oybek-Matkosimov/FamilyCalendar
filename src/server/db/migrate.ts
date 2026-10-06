import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { createDb } from './client';

export async function runMigrations(url: string) {
  const { db, sql } = createDb(url, 1);
  try {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src/server/db/migrations') });
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
