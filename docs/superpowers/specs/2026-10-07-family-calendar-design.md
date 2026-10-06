# Family Shared Calendar — Design Spec

Date: 2026-10-07 · Status: approved in conversation, pending written-spec review

## 1. Purpose and scope

A production-grade web app where one family shares one calendar, accessed with a calendar ID + password (no email/accounts). Answers "what is everyone doing on date X?" and flags overlapping schedules automatically.

Out of scope for v1: email/SMS notifications (schema/event bus designed to allow them later), social login, billing, multi-calendar-per-user.

## 2. Stack

| Concern | Choice | Reason |
|---|---|---|
| App | Next.js (App Router), React, TypeScript `strict` | One deployable; route handlers = API |
| DB | PostgreSQL 16 | Constraints, indexes, LISTEN/NOTIFY, transactions |
| Data access | Drizzle ORM + generated SQL migrations (`drizzle-kit`) | Typed, reviewable migrations |
| Validation | Zod (shared client/server) | Single source of truth |
| Password hash | argon2id (`@node-rs/argon2`) | Current best practice |
| Recurrence/time | `rrule`, Luxon | DST-correct, tested libs |
| Real-time | SSE + Postgres LISTEN/NOTIFY; client revalidate-on-focus fallback | No Redis; multi-instance safe |
| Logging | pino with redaction | Structured, no secrets |
| Tests | Vitest (unit+integration), Playwright (UI) | |
| Test/dev DB | `embedded-postgres` (real PG binaries via npm) locally; real Postgres in CI/prod | Docker not present on dev machine |

## 3. Layering

```
src/app/**            pages + route handlers (thin: parse → auth → service → respond)
src/components/**     UI components
src/server/auth/      sessions, password hashing, rate limit / lockout, CSRF/origin check
src/server/authz/     authorize(actor, action, resource) — single policy source
src/server/services/  calendars, members, events, invites, conflicts, recurrence, audit
src/server/db/        schema, client, repositories (every query scoped by calendar_id), migrations
src/server/realtime/  LISTEN/NOTIFY hub, SSE
src/lib/              validation schemas, time utils, shared types
src/config/           env parsing (zod), fails fast at startup
tests/                unit, integration, e2e
ops/                  Dockerfile, compose, backup/restore scripts, runbooks
```

## 4. Schema

All ids uuid. Timestamps `timestamptz`.

- **calendars**: id, code (unique, `XXXX-NNNN`), name, password_hash, recovery_hash, timezone (IANA), settings jsonb (`membersCanEditAll` default true), owner_member_id (deferrable FK), created_at, updated_at, deleted_at.
- **members**: id, calendar_id FK, name, name_key (lowercased/trimmed), role (`owner|member`), color, created_at, last_active_at, removed_at. Partial unique `(calendar_id, name_key) WHERE removed_at IS NULL`. Unique `(calendar_id, id)` for composite FKs.
- **sessions**: id, token_hash (unique, sha-256), calendar_id, member_id (composite FK), created_at, expires_at, revoked_at, user_agent.
- **events**: id, calendar_id, member_id (composite FK → members(calendar_id,id)), title, description, location, start_utc, end_utc, all_day, tz, local_start, local_end (wall-clock for recurrence), rrule (nullable), recur_until, exceptions jsonb (skipped occurrence dates), version int, created_by, created_at, updated_by, updated_at, deleted_at. CHECK `end_utc > start_utc`; CHECK duration ≤ 7 days.
- **event_audit**: id, calendar_id, event_id, action (`create|update|delete|restore`), actor_member_id, at, before jsonb, after jsonb.
- **invites**: id, calendar_id, token_hash, created_by, expires_at, max_uses, uses, revoked_at.
- **auth_attempts**: key (e.g. `cal:MATK-4829`, `ip:1.2.3.4`), failures, window_start, locked_until.
- **idempotency_keys**: key, calendar_id, member_id, request_hash, response jsonb, created_at (TTL-cleaned).

Indexes: events `(calendar_id, start_utc, end_utc) WHERE deleted_at IS NULL`, `(calendar_id, member_id)`; members `(calendar_id)`; audit `(calendar_id, event_id, at)`; sessions `(token_hash)`, `(member_id)`.

## 5. Auth and authorization

- **Create**: validate → hash password (argon2id) → generate code → in one transaction insert calendar + owner member + session; generate one-time recovery code (stored hashed, returned once).
- **Join** (code + name + password, or invite token which pre-fills the code but **still requires the password**): verify; uniform error `Invalid calendar ID or password` for unknown code and wrong password; dummy hash on unknown code to equalize timing. If `name_key` exists and not removed → client shows "Is this you?"; confirm signs in as that member (rule: shared password means no per-person identity; documented trade-off). Otherwise creates member.
- **Session**: 256-bit random token; cookie `HttpOnly; Secure (prod); SameSite=Lax; Path=/`; DB stores sha-256. 30-day sliding expiry. Logout and member removal revoke sessions.
- **Brute force**: per-IP and per-calendar-code counters in `auth_attempts`; exponential lockout (e.g. 5 failures → 1 min, doubling, cap 1 h); applies to join, recovery, password-change-verify. General API rate limit per session/IP.
- **Authorization**: every handler derives `{calendarId, memberId, role}` from the session only; URL/body ids are checked against it, never trusted. Repositories require `calendarId` argument. Cross-calendar resource → 404.
- **Policy**: Owner: edit calendar name/settings/timezone, remove members, manage invites, change/reset password, delete calendar, edit/delete any event. Member: view all, create events (for any member), edit any event iff `membersCanEditAll`, delete own events only (events where `created_by` or `member_id` = self; owner always can).
- **Recovery**: owner submits recovery code + new password → rotates password, issues new recovery code, revokes all sessions.

## 6. Events, time, recurrence

- Non-recurring: stored as UTC instants plus calendar tz at creation.
- Recurring: stored with wall-clock `local_start/local_end` + `tz` + RRULE (DAILY, WEEKDAYS = FREQ=WEEKLY;BYDAY=MO..FR, WEEKLY, MONTHLY, custom interval/BYDAY/COUNT/UNTIL via builder, no raw RRULE from client — server builds and validates it). Occurrences expanded on read within the requested range (bounded to 1 year per request, max 2,000 occurrences), so DST shifts keep wall-clock time.
- Edit/delete scopes for recurring: "this occurrence" (adds exception / creates override event linked via `series_id`), "whole series". "This and following" is deferred (documented non-goal).
- Events crossing midnight: one stored interval; display and per-day views clip to day boundaries.
- Calendar timezone is configurable by the owner; stored UTC data is unaffected; recurring events keep their own `tz`.

## 7. Conflict detection

- Computed on the server over expanded occurrences in a range (`GET /api/conflicts`), and attached per-day in event queries.
- Intervals half-open `[start,end)`: touching events (10–11, 11–12) do **not** conflict; identical start = conflict; containment = conflict; partial overlap = conflict.
- Overlaps between different members **and** double-booking the same member are flagged (labeled accordingly).
- Algorithm: sort by start, sweep with active set; output groups of mutually-connected overlaps plus pairwise overlap window (`overlapStart/overlapEnd`) and members involved, so UI can say "Dad and Mom overlap 11:30 AM–12:00 PM". Multi-event overlaps produce one group listing all pairs.
- All-day events do not create conflicts (displayed separately) unless explicitly timed.
- Date status: `none | scheduled | conflict` (per calendar-timezone day).

## 8. Concurrency and reliability

- Optimistic locking: `PATCH/DELETE` require `version`; mismatch → 409 with current event; UI offers review/merge-by-reapply.
- `Idempotency-Key` header on creates (UI generates per form open); duplicate returns the original response.
- Multi-step writes in transactions (create calendar, delete calendar, remove member, edit + audit).
- Removing a member: soft-remove; their events stay and show "Former member"; owner chooses at removal to keep, reassign to another member, or delete.
- Deleting events: soft-delete + audit; owner can restore from history (v1: restore endpoint, minimal UI in event history).
- Calendar deletion: owner-only, requires typing calendar name; purges data in one transaction.
- DB/network failure: API returns structured errors `{error:{code,message}}` with 503 for DB outages, no stack traces; client shows retry banner, preserves form input, never clears unsaved forms; refresh during save is safe thanks to idempotency.

## 9. Real-time

`NOTIFY calendar_<id-hash>` after each committed mutation with `{type, eventId}`; one dedicated listener connection per server process (reconnects with backoff) fans out to SSE clients of that calendar. SSE includes heartbeat and `Last-Event-ID`-less design: on (re)connect the client refetches current range. Fallback: refetch on window focus, online event, and 60 s interval when SSE is down.

## 10. API

```
POST   /api/calendars
POST   /api/auth/join           POST /api/auth/logout      GET /api/auth/me
POST   /api/auth/recover
GET    /api/calendar            PATCH /api/calendar        DELETE /api/calendar
POST   /api/calendar/password
GET    /api/members             DELETE /api/members/:id
GET    /api/invites             POST /api/invites          DELETE /api/invites/:id
GET    /api/join-info?token=    (public: calendar name + code only)
GET    /api/events?from&to&member&q
POST   /api/events              PATCH/DELETE /api/events/:id
GET    /api/events/:id/history  POST /api/events/:id/restore
GET    /api/conflicts?from&to
GET    /api/stream
GET    /api/health
```

Errors: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found / cross-calendar, 409 version conflict, 429 rate limit/lockout, 503 database unavailable.

## 11. Security

Zod validation + sanitization (trim, length limits, strip control chars) on all input; parameterized queries only; React escaping, no `dangerouslySetInnerHTML`; CSP (self only, nonce), HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors none; CSRF: Origin/Host check + required `X-Requested-With` header on mutations; secrets via env only (validated at boot); pino redaction of password/token/cookie fields; passwords and tokens never logged or stored plain; invite links contain only a random token (hashed in DB), never the password.

## 12. UI

- Landing: Create / Join. Create shows calendar ID, share/invite, one-time recovery code with "I saved it" confirmation; password never redisplayed.
- Dashboard: header (name, current member, members, settings), member filter chips, search, month/week/day views, Today, prev/next, current-date marker; panels: Today's Schedule, Upcoming (7 days), Conflicts ("⚠ N conflicts this week" → list).
- Date status uses icon + text label + color: ● Scheduled (green), ⚠ Conflict (red), none (plain). Passes WCAG AA contrast; visible focus; keyboard navigable; ARIA labels on cells.
- Day detail: chronological list with member, comment, last-edited-by, conflict banner, create/edit/delete; history popover (Created by X — time; Edited by Y — time).
- Mobile-first: bottom-sheet dialogs, 44px touch targets, month view collapses to dot indicators + agenda list.
- Member colors for at-a-glance attribution.

## 13. Notifications (future-ready)

Mutations emit domain events through a small internal `eventBus` (`event.created|updated|deleted`, `conflict.detected`); only the realtime subscriber is wired in v1. Future reminders/email subscribe without touching services.

## 14. Testing

- Unit: conflict sweep (same start, containment, partial, touching, midnight, multi-overlap), recurrence expansion incl. DST, authz policy matrix, validation schemas.
- Integration (real Postgres): join correct/incorrect password, lockout, cross-calendar access (events/members/invites by foreign ids → 404), owner vs member permissions, create/edit/delete + audit rows, optimistic-lock 409, idempotency, transaction rollback, member removal with events, persistence across new connections, migrations apply cleanly from empty and are idempotent.
- E2E (Playwright, mobile + desktop viewports): create calendar, join, month/week/day navigation, create/edit event, conflict indicator appears, responsive layout.
- Honest limit: Playwright requires browser downloads; if unavailable in the build environment, e2e specs are still written and run is reported separately.

## 15. Operations

- Dockerfile (multi-stage, non-root), `docker-compose.yml` (app + postgres + caddy HTTPS + backup sidecar), `.env.example`.
- Migrations run via `npm run db:migrate` as a separate release step; forward-only, expand/contract policy documented.
- Backups: nightly `pg_dump -Fc` script with retention (30 daily, 12 monthly) to S3-compatible storage or local volume; managed PITR recommended; restore runbook with verification steps in `ops/RESTORE.md`.
- Docs: `DEPLOY.md` (Railway/Fly.io + managed Postgres, or compose on a VPS), monitoring recommendations (uptime on `/api/health`, Sentry, log shipping, DB disk/connection alerts), security checklist.
- Hosting requires a long-running Node process (SSE/LISTEN); not serverless.

## 16. Build phases (each leaves prior phases green)

1 Scaffold, config, schema, migrations · 2 Create/join/sessions/lockout · 3 Members + invites · 4 Calendar UI · 5 Event CRUD + audit · 6 Recurrence + conflicts · 7 AuthZ hardening, headers, CSRF · 8 Realtime + idempotency/locking · 9 Test suites · 10 Ops, backups, docs.
