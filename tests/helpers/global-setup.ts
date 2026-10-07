import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** One embedded PostgreSQL for the whole test run (each test file creates its own database inside it). */
export default async function setup() {
  if (process.env.TEST_DATABASE_URL_BASE) return undefined;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'fc-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  process.env.TEST_DATABASE_URL_BASE = `postgres://postgres:postgres@localhost:${port}`;
  return async () => {
    await pg.stop().catch(() => {});
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort on Windows */ }
  };
}
