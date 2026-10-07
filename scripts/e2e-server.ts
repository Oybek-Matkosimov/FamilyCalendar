/**
 * Boots a throwaway embedded PostgreSQL + the app (dev mode) on port 3100 for Playwright.
 * Dev mode keeps NODE_ENV != production so http://localhost cookies work.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { runMigrations } from '../src/server/db/migrate';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-e2e-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const base = `postgres://postgres:postgres@localhost:${port}`;
  const admin = postgres(`${base}/postgres`, { max: 1 });
  await admin.unsafe('create database e2e');
  await admin.end();
  const url = `${base}/e2e`;
  await runMigrations(url);

  const next = spawn('npx', ['next', 'dev', '-p', '3100'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: url, APP_ORIGIN: 'http://localhost:3100', TRUST_PROXY: 'true', NODE_ENV: 'development' },
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    next.kill();
    await pg.stop().catch(() => {});
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  next.on('exit', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
