import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

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

let server: EmbeddedPostgres | undefined;
let starting: Promise<number> | undefined;
let dataDir: string | undefined;

async function ensureServer(): Promise<number> {
  if (process.env.TEST_DATABASE_URL_BASE) return 0;
  starting ??= (async () => {
    const port = await freePort();
    server = new EmbeddedPostgres({
      databaseDir: (dataDir = mkdtempSync(join(tmpdir(), 'fc-pg-'))),
      user: 'postgres', password: 'postgres', port, persistent: true,
      onLog: () => {}, onError: () => {},
    });
    await server.initialise();
    await server.start();
    return port;
  })();
  return starting;
}

export async function createTestDb() {
  const port = await ensureServer();
  const base = process.env.TEST_DATABASE_URL_BASE ?? `postgres://postgres:postgres@localhost:${port}`;
  const name = 'test_' + randomBytes(6).toString('hex');
  const admin = postgres(`${base}/postgres`, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  return { url: `${base}/${name}`, base, name };
}

export async function stopTestServer() {
  if (server) {
    await server.stop().catch(() => {});
    server = undefined;
    starting = undefined;
    // Windows may briefly hold file locks after shutdown; cleanup is best-effort.
    try { if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* ignore */ }
  }
}
