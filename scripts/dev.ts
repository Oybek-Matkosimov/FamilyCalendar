/**
 * Local development: boots a persistent embedded PostgreSQL (data in .data/pg), applies migrations,
 * then starts `next dev` against it. No Docker or system Postgres required.
 * For production use a real PostgreSQL and `npm run build && npm start` (see docs/DEPLOY.md).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { runMigrations } from '../src/server/db/migrate';

const PORT = Number(process.env.PG_PORT ?? 54329);
const dir = path.resolve('.data/pg');

async function main() {
  mkdirSync(path.dirname(dir), { recursive: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: true, onLog: () => {}, onError: () => {} });
  if (!existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const base = `postgres://postgres:postgres@localhost:${PORT}`;
  const admin = postgres(`${base}/postgres`, { max: 1 });
  const exists = await admin`select 1 from pg_database where datname = 'familycal'`;
  if (exists.length === 0) await admin.unsafe('create database familycal');
  await admin.end();
  const url = `${base}/familycal`;
  await runMigrations(url);
  console.log(`[dev] database ready on port ${PORT}`);

  const next = spawn('npx', ['next', 'dev', '-p', process.env.PORT ?? '3000'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: url, APP_ORIGIN: process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? '3000'}` },
  });
  const shutdown = async () => {
    next.kill();
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  next.on('exit', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
