# Security checklist

Each control lists where it is implemented and which automated test proves it. Tick the "your deployment" items yourself before going live.

## Built into the app (verified by tests)

| Control | Where | Proven by |
|---|---|---|
| Calendar password stored only as an argon2id hash; never logged or returned | `src/server/auth/password.ts`, `services/calendars.ts` | `calendars.test.ts` (hash prefix, no plain text), `security.test.ts` (no secrets in any response, no password in logs) |
| Recovery code shown once, stored hashed | `services/calendars.ts` | `calendars.test.ts` |
| Session tokens are random 256-bit values; only a SHA-256 hash is stored | `auth/session.ts`, `auth/tokens.ts` | `auth-primitives.test.ts` |
| Cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production | `auth/request.ts` | `api-calendars.test.ts`, `npm run smoke:prod` |
| Wrong ID and wrong password give the same error and similar timing | `joinCalendar` (dummy hash for unknown IDs) | `calendars.test.ts` |
| Brute-force lockout (5 failures, then 1, 2, 4 … up to 60 minutes; the count is forgotten only after 15 quiet minutes, so steady guessing keeps escalating), stored in the database so it holds across instances and restarts | `auth/lockout.ts` | `auth-primitives.test.ts`, `review-fixes.test.ts`, `calendars.test.ts`, `auth.spec.ts` (e2e) |
| Signing in as an existing member needs the shared password; signing in as the **owner** also needs the recovery code, so a member cannot take over the calendar | `services/calendars.ts` | `review-fixes.test.ts`, `auth.spec.ts` (e2e) |
| Dates are limited to 30 years either side of today, so one request cannot make the server expand recurring events for centuries | `lib/time.ts`, `lib/validation.ts`, `services/events.ts` | `review-fixes.test.ts` |
| Client IP for rate limits comes from the trusted (right-most) `X-Forwarded-For` hop only; forged left-hand values are ignored | `auth/request.ts` | `review-fixes.test.ts` |
| Invisible and control characters are stripped from names and text, so look-alike or blank names cannot be created | `lib/validation.ts` | `review-fixes.test.ts` |
| Authorization on every protected endpoint; tenancy comes from the session, never from the URL | `server/api.ts`, `authz/policy.ts`, repositories always filter by `calendar_id` | `security.test.ts` (unauthenticated, tenant and CSRF sweeps over every route), `events.test.ts`, `members-invites.test.ts` |
| Changing an ID in a URL or request returns 404 and never another family's data | all `[id]` routes | `security.test.ts` tenant sweep |
| Database enforces that an event's member belongs to the same calendar | composite foreign key | `schema.test.ts` |
| CSRF: mutating requests need a same-origin `Origin` header and `X-Requested-With: fetch`, on top of `SameSite=Lax` | `server/api.ts` | `security.test.ts` CSRF sweep |
| Input validation and normalisation on the server for every field; SQL only through parameterised queries | `lib/validation.ts`, Drizzle | `validation.test.ts`, `events.test.ts` |
| XSS: React escapes all text, no `dangerouslySetInnerHTML`, strict CSP with per-request nonce | `middleware.ts`, `security-headers.ts` | `security-headers.test.ts`, `npm run smoke:prod` (every inline script carries the nonce) |
| Security headers: CSP, HSTS (production), nosniff, frame denial, referrer and permissions policy | `security-headers.ts` | `security-headers.test.ts`, `npm run smoke:prod` |
| Rate limiting of API calls per session / IP | `server/rate-limit.ts` | `security-headers.test.ts`, `security.test.ts` |
| Invite links contain a random token (hashed in the database), expire, can be limited and revoked, and never bypass the password | `services/invites.ts` | `members-invites.test.ts` |
| Removing a member ends their sessions and live stream immediately | `services/members.ts`, `api/stream` | `members-invites.test.ts`, `api-stream.test.ts` |
| No server secrets or database strings in browser files | build output | `npm run smoke:prod` |
| Audit trail of every event create / edit / delete / restore | `services/audit.ts` | `events.test.ts` |
| Edits are all-or-nothing (transactions); duplicate submissions and simultaneous edits are handled (idempotency keys, version checks) | `services/events.ts` | `events.test.ts`, `events-rollback.test.ts` |
| Safe migrations when several instances start together | `db/migrate.ts` (advisory lock) | `migrations.test.ts` |

## Your deployment

- [ ] `APP_ORIGIN` is the real `https://` address; the site opens only over HTTPS (HTTP redirects)
- [ ] `TRUST_PROXY=true` **only** if a trusted proxy sits in front, and the app port is not reachable from the internet except through it
- [ ] The database is not reachable from the internet (private network or firewall), uses a long random password, and TLS where the provider supports it
- [ ] `DATABASE_URL` and other secrets are set as environment variables / platform secrets, not committed (`.env*` is git-ignored)
- [ ] Automated backups are on, a restore drill has been completed (`ops/RESTORE.md`), and an off-site copy exists
- [ ] Uptime monitoring on `/api/health` and an alert for failed backups
- [ ] The **recovery code** for each calendar was saved by its owner
- [ ] `npm audit --omit=dev` reviewed, and dependencies updated regularly (enable Dependabot or Renovate)
- [ ] Operating system and Docker images updated regularly
- [ ] Only trusted people have access to the hosting account and the database

## Things to know

- Everyone in a family shares one password. Anyone who knows it can join, and can sign in as any existing **member** name (the app asks "Is this you?"). Signing in as the **owner** additionally needs the owner's recovery code. The owner can remove people and change the password, which signs everyone else out. A removed person can rejoin with the shared password unless the password is changed too.
- Calendar IDs (`ABCD-1234`) are short so they are easy to share. The password and the lockout, not the ID, protect the data. Choose a strong password.
- A person who gets locked out of a calendar (five wrong guesses) waits up to a minute, then longer if it continues. An attacker can cause this delay for a family. That is the price of brute-force protection without accounts.
