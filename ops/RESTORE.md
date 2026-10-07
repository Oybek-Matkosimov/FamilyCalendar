# Backup and recovery

Your family's calendar lives in one PostgreSQL database. This page explains how it is backed up and how to get it back.

## What is protected, and how fast you can recover

| Layer | What it gives you | Data you could lose |
|---|---|---|
| Nightly logical dump (`ops/backup.sh`) | A compressed `.dump` file, verified readable, kept 30 days + one per month for 12 months | Up to 24 hours |
| Off-site copy (optional `S3_BUCKET`) | The same dump on storage that survives losing the server | Up to 24 hours |
| Managed Postgres point-in-time recovery (recommended on Railway, Fly, Neon, Supabase, RDS…) | Restore to any second in the last 7–30 days | Seconds to minutes |

Use both: the provider's point-in-time recovery for fast, fine-grained restores, and the dump files for an independent copy you control.

Only the database needs backing up. The app is stateless and the sessions table can be lost safely (everyone just signs in again).

`bash ops/test-backup.sh` checks the script's retention and failure handling with stubbed tools (no database needed).

## Run a backup by hand

```bash
export DATABASE_URL='postgres://user:password@host:5432/familycal'
./ops/backup.sh            # writes ./backups/familycal-<UTC timestamp>.dump
```

Needs `pg_dump` and `pg_restore` (PostgreSQL client tools, same major version as the server or newer) and bash 4+. In the Docker Compose stack the `backup` service does this every 24 hours into the `backups` volume.

Settings (environment variables): `BACKUP_DIR` (default `./backups`), `KEEP_DAILY` (30), `KEEP_MONTHLY` (12), and for an off-site copy `S3_BUCKET`, `S3_ENDPOINT` (for non-AWS providers), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

If you do not use the Compose stack, schedule it with cron, for example `15 3 * * * cd /srv/familycal && DATABASE_URL=... ./ops/backup.sh >> backup.log 2>&1`. The script exits non-zero on any failure, so alert on that (see monitoring in `docs/DEPLOY.md`).

## Practise restoring (do this every quarter)

A backup you have never restored is a hope, not a backup.

```bash
export DATABASE_URL='postgres://user:password@host:5432/familycal'   # a role that can CREATE DATABASE
./ops/restore.sh backups/familycal-20261007T031500Z.dump
```

This restores into a temporary database, prints row counts (calendars, members, events, audit rows), then drops it. Nothing in production is touched. Compare the counts with what you expect.

**Drill checklist**

- [ ] Newest backup is less than 26 hours old
- [ ] `restore.sh` finishes without errors
- [ ] Row counts look right
- [ ] You know where the off-site copy is and can download it
- [ ] Write the date in your notes

## Recover from a disaster

Use this when data was deleted by mistake, the database is corrupted, or the server is gone.

1. **Stop the app** so nobody writes while you restore (`docker compose stop app`, or scale the service to zero).
2. **Keep what exists.** If the database still answers, take a fresh dump first: `./ops/backup.sh`. Even a damaged database is worth keeping.
3. **Choose the restore point.**
   - Managed Postgres with point-in-time recovery: restore to just before the problem using the provider's console. Prefer restoring into a *new* database and pointing the app at it.
   - Otherwise pick the newest good dump from `backups/` (or download it from your off-site bucket).
4. **Prove it works** with the drill command above against that dump.
5. **Restore into the target database** (replaces everything in it):
   ```bash
   export RESTORE_TARGET_URL='postgres://user:password@host:5432/familycal'
   ./ops/restore.sh backups/familycal-20261007T031500Z.dump --into-production --yes
   ```
   For a brand new empty server, create the database and user first (`createdb familycal`).
6. **Bring the schema up to date.** The dump contains the schema as it was at backup time. Apply any newer migrations: `npm run db:migrate` (or start the app with `AUTO_MIGRATE=true`).
7. **Start the app** and check `GET /api/health` returns `{"ok":true}`.
8. **Verify** by signing in, opening the calendar and spot-checking recent events.
9. **Tell the family** which time the data was restored to. Anything added after the backup must be re-entered.

### Restoring a single family or event

The audit table (`event_audit`) keeps the before and after values of every event change, including deletes. To recover one deleted event without a full restore, restore a dump into a scratch database (the drill does exactly this) and copy the rows you need with `psql`.

### Recovery targets

- **Recovery point objective:** at most 24 hours with the nightly dump alone, seconds to minutes with provider point-in-time recovery.
- **Recovery time objective:** about 30 minutes for a database of this size, most of it spent verifying.

## Database migrations and backups

- Migrations are forward-only SQL files in `src/server/db/migrations`.
- **Take a backup before deploying a release that contains a new migration.**
- Prefer additive changes (new nullable columns, new tables) first and removals in a later release, so the previous version of the app keeps working while a deploy rolls out.
- To go back after a bad migration, restore the pre-deploy backup and deploy the previous app version.

## Verified on

The retention logic of `backup.sh` was exercised with stubbed `pg_dump` / `pg_restore` (100 daily files over 14 months, `KEEP_DAILY=5`, `KEEP_MONTHLY=3` → kept the 5 newest plus the oldest of each of the last 3 months). A real `pg_dump` → `restore.sh` drill has **not** been run in this repository's build environment (no PostgreSQL client tools were available there). Run the drill above once on your own server before relying on it.
