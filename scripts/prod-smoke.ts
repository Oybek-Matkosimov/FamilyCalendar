/**
 * Production smoke test. Run AFTER `npm run build`:  npm run smoke:prod
 *
 * Boots the standalone server (the same layout the Docker image uses) against a throw-away embedded PostgreSQL
 * with NODE_ENV=production and AUTO_MIGRATE=true, then checks what only production mode exposes:
 *   - start-up migration + /api/health
 *   - security headers (HSTS, CSP with nonce)
 *   - every inline <script> of every page carries the CSP nonce (otherwise a strict CSP blanks the page)
 *   - Secure + HttpOnly session cookie, create calendar -> authenticated request
 * Exit code 0 only if everything holds.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

const free = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

async function main() {
  if (!existsSync('.next/standalone/server.js')) throw new Error('Run `npm run build` first (output: standalone).');
  const pgDir = mkdtempSync(path.join(tmpdir(), 'smoke-pg-'));
  const appDir = mkdtempSync(path.join(tmpdir(), 'smoke-app-'));
  const pgPort = await free();
  const appPort = await free();
  const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'postgres', password: 'postgres', port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await pg.initialise();
    await pg.start();
    const admin = postgres(`postgres://postgres:postgres@localhost:${pgPort}/postgres`, { max: 1 });
    await admin.unsafe('create database smoke');
    await admin.end();

    cpSync('.next/standalone', appDir, { recursive: true });
    mkdirSync(path.join(appDir, '.next'), { recursive: true });
    cpSync('.next/static', path.join(appDir, '.next/static'), { recursive: true });
    cpSync('src/server/db/migrations', path.join(appDir, 'src/server/db/migrations'), { recursive: true });

    const leaked = walk('.next/static')
      .filter((f) => /\.(js|css|html|json|map)$/.test(f))
      .filter((f) => /DATABASE_URL|postgres:\/\/|password_hash|argon2/i.test(readFileSync(f, 'utf8')));
    check('no server secrets or database strings in browser files', leaked.length === 0, leaked.join(', '));

    const origin = 'https://calendar.example.com';
    let log = '';
    server = spawn('node', ['server.js'], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, NODE_ENV: 'production', PORT: String(appPort), HOSTNAME: '127.0.0.1', APP_ORIGIN: origin,
        TRUST_PROXY: 'true', AUTO_MIGRATE: 'true', DATABASE_URL: `postgres://postgres:postgres@localhost:${pgPort}/smoke`,
      },
    });
    server.stdout?.on('data', (d) => (log += d));
    server.stderr?.on('data', (d) => (log += d));
    const base = `http://127.0.0.1:${appPort}`;

    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* still starting */ }
    }
    check('server starts, migrates and reports healthy', healthy, log.slice(-800));
    if (!healthy) return;

    for (const route of ['/', '/create', '/join', '/calendar']) {
      const res = await fetch(base + route);
      const html = await res.text();
      const csp = res.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      check(`${route}: 200 with a CSP nonce`, res.status === 200 && !!nonce, `status ${res.status}`);
      check(`${route}: HSTS present`, (res.headers.get('strict-transport-security') ?? '').includes('max-age='));
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '').filter((attrs) => !/\bsrc=/.test(attrs));
      const bad = inline.filter((attrs) => !nonce || !attrs.includes(`nonce="${nonce}"`));
      check(`${route}: all ${inline.length} inline scripts carry the nonce`, inline.length > 0 && bad.length === 0, `${bad.length} without nonce`);
    }

    const create = await fetch(`${base}/api/calendars`, {
      method: 'POST',
      headers: { origin, 'x-requested-with': 'fetch', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ familyName: 'Smoke Family', memberName: 'Dad', password: 'correct horse', timezone: 'UTC' }),
    });
    const setCookie = create.headers.get('set-cookie') ?? '';
    check('create calendar returns 201', create.status === 201, String(create.status));
    check('session cookie is HttpOnly, Secure, SameSite=Lax', /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie.replace(/=[^;]+/, '=…'));
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: setCookie.split(';')[0] ?? '' } });
    check('authenticated request works', me.status === 200 && (await me.json()).name === 'Smoke Family');
    const anon = await fetch(`${base}/api/auth/me`);
    check('anonymous request is rejected', anon.status === 401);
  } finally {
    server?.kill();
    await pg.stop().catch(() => {});
    try {
      rmSync(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(pgDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* best effort on Windows */ }
  }
}

main()
  .then(() => {
    console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll production smoke checks passed');
    process.exit(failures.length ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
