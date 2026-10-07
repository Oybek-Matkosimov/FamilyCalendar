# Deploying Family Calendar

The app is one Node.js process (Next.js) plus PostgreSQL. It needs a **long-running server** because live updates use a held-open connection (Server-Sent Events) and a database `LISTEN` connection. Do not deploy it to a serverless platform such as Vercel.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/familycal`. Use `?sslmode=require` for managed databases that need TLS. |
| `APP_ORIGIN` | yes | The public address people use, **with https**, e.g. `https://calendar.example.com`. The app refuses to start in production with an http address. It is also what blocks cross-site form posts. |
| `TRUST_PROXY` | behind a proxy: yes | Set `true` when a reverse proxy / platform router appends the client address to `X-Forwarded-For` (Caddy, Railway, Fly, Render, nginx…). Without it the app cannot tell visitors apart, so per-IP limits (anonymous API rate limit, calendar-creation limit, per-IP login lockout) are **skipped**; the per-calendar lockout and per-member limits still apply. Never set it when the app is reachable directly from the internet. |
| `TRUSTED_PROXY_HOPS` | optional (default `1`) | How many trusted proxies sit in front of the app. The client address is taken that many entries from the **right** of `X-Forwarded-For`; anything further left is client-supplied and ignored. Use `1` for Caddy/Railway/Render/Fly, `2` if you also use a CDN such as Cloudflare in front of the platform. A wrong value makes everyone share one address, or lets visitors forge theirs. |
| `AUTO_MIGRATE` | optional | `true` applies pending migrations when the server starts. Safe with several instances (advisory lock). Convenient for a single-service host. |
| `LOG_LEVEL` | optional | `debug`, `info` (default), `warn`, `error`. |
| `PORT` / `HOSTNAME` | optional | Default `3000` / `0.0.0.0` in the Docker image. |

Secrets live only in environment variables. Nothing secret is bundled into browser code. `npm run smoke:prod` and the CI job check the built client files for the database URL.

## Option A: a platform (Railway, Fly.io, Render) with managed PostgreSQL

1. Create a PostgreSQL database. Choose a plan with **point-in-time recovery** and automatic backups.
2. Create a service from this repository using `ops/Dockerfile` (target `runner`, the default).
3. Set the variables: `DATABASE_URL` (from the database), `APP_ORIGIN` (your https address), `TRUST_PROXY=true`, `AUTO_MIGRATE=true`.
   - If you would rather run migrations as a separate release step, leave `AUTO_MIGRATE` unset and run the image built from the `migrate` target as the release command (`npx tsx src/server/db/migrate.ts`).
4. Health check path: `/api/health` (returns 200 `{"ok":true}`, or 503 when the database is unreachable).
5. Add your domain; the platform terminates HTTPS. Keep a single instance to start with. More are fine: live updates fan out through PostgreSQL, not process memory.
6. Add the nightly dump as a scheduled job (platform cron or a second small service running `ops/backup.sh` with `S3_BUCKET` set; it needs `pg_dump` and the `aws` CLI, see `ops/backup.Dockerfile`) in addition to the database's own backups. See `ops/RESTORE.md`.

## Option B: your own server with Docker Compose

```bash
git clone <your repo> familycal && cd familycal
cp ops/.env.example .env      # set DOMAIN and POSTGRES_PASSWORD (long random), optional S3_* for off-site backups
docker compose -f ops/docker-compose.yml --env-file .env up -d --build
```

This starts PostgreSQL, applies migrations, starts the app, puts Caddy in front with automatic HTTPS (the `DOMAIN` must point at the server and ports 80/443 must be open) and runs a nightly backup into the `backups` volume. Update later with `git pull && docker compose -f ops/docker-compose.yml --env-file .env up -d --build` (the migrate step runs first).

## Database migrations

- Forward-only SQL in `src/server/db/migrations`, tracked by Drizzle in `drizzle.__drizzle_migrations`.
- Create a new one after changing `src/server/db/schema.ts`: `npm run db:generate`, review the SQL, commit it.
- Apply: `npm run db:migrate` (needs `DATABASE_URL`), the `migrate` Compose service, or `AUTO_MIGRATE=true`.
- Releases: back up first, ship additive changes before removals, so the old app version keeps working during a rollout.

## Logging and monitoring

- The app logs JSON lines to stdout (pino). Passwords, recovery codes, tokens and cookies are redacted. Send stdout to your platform's log viewer or a log service.
- **Uptime:** an external monitor (UptimeRobot, Better Stack, Healthchecks.io…) on `https://<domain>/api/health`, alerting after 2 failures.
- **Errors:** alert on log lines with `"level":50` (error). To get stack traces and grouping, add Sentry or a similar service later; the central error handler is `errorResponse` in `src/server/api.ts`.
- **Database:** alert on disk usage above 80 %, connection count near the limit, and failed backups.
- **Backups:** alert when the newest dump is older than 26 hours (a "dead man's switch" ping at the end of `backup.sh` works well) and run the restore drill every quarter.
- **Abuse:** watch for repeated `429` responses on `/api/auth/join`; they mean someone is guessing a password.

## After the first deploy

1. Open the site, create a calendar, save the **recovery code**, and add an event.
2. Open it from your phone with the calendar ID and password.
3. Add an event on one device and watch it appear on the other without refreshing.
4. Run `./ops/backup.sh` and then the restore drill from `ops/RESTORE.md`.
5. Go through `docs/SECURITY_CHECKLIST.md`.

## Known limits (v1)

- Rate limits for ordinary API calls are per server process. Password guessing limits are stored in the database and are shared by all instances.
- Notifications (email, SMS, push) are not implemented. The domain event bus in `src/server/events-bus.ts` is where reminders will plug in.
- Restoring a deleted event has an API (`POST /api/events/:id/restore`, owner only) but no button yet.
- "This and all following events" for repeating events is not supported; edit one occurrence or the whole series.
- `npm audit` reports advisories in PostCSS bundled with Next.js 15 (they concern processing attacker-supplied CSS at build time; this app only builds its own CSS). The fix needs a major Next.js upgrade; plan one when convenient and re-run the audit.
