import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let server: EmbeddedPostgres | undefined;
let starting: Promise<number> | undefined;

async function ensureServer(): Promise<number> {
  if (process.env.TEST_DATABASE_URL_BASE) return 0;
  starting ??= (async () => {
    const port = 54000 + Math.floor(Math.random() * 1000);
    server = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), 'fc-pg-')),
      user: 'postgres', password: 'postgres', port, persistent: false,
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
    await server.stop();
    server = undefined;
    starting = undefined;
  }
}
