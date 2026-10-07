# Family Calendar

One shared calendar for a whole family. Everyone joins with a calendar ID and password (no email, no accounts), sees everyone's schedule on one page, and gets a clear warning when two events overlap.

- Month, week and day views, built for phones first
- Each event belongs to a person and shows who created and last edited it, with full history
- Days with events are marked ✓ Scheduled; overlapping events are marked ⚠ Conflict (icons and text, not just colour)
- Repeating events (daily, weekdays, weekly, monthly, custom) included in conflict checks
- Live updates: when someone adds an event, everyone's open calendar updates without a refresh
- Owner tools: invite links that expire, remove members, change the password, delete the calendar, recovery code

## Run it on your computer

Needs Node.js 22 or newer. No Docker and no separate database install: development starts its own PostgreSQL.

```bash
npm install
npm run dev          # http://localhost:3000, data kept in .data/
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server with its own embedded PostgreSQL |
| `npm test` | Unit and integration tests against a real PostgreSQL |
| `npm run test:e2e` | Browser tests (Playwright) at desktop and phone sizes. Locally uses installed Microsoft Edge; set `PW_CHANNEL=chrome` to use Chrome, or run `npx playwright install chromium` and `PW_CHANNEL=` for bundled Chromium |
| `npm run typecheck` | TypeScript (strict) |
| `npm run build` then `npm run smoke:prod` | Production build, then boots it and checks headers, CSP nonces, cookies, migrations |
| `npm run db:generate` / `npm run db:migrate` | Create / apply database migrations |

## How it is built

```
Browser (React)  ──HTTPS──▶  Route handlers /api/*  →  services  →  repositories  →  PostgreSQL
        ▲                                                                   │
        └────────── Server-Sent Events ◀── LISTEN/NOTIFY ◀──────────────────┘
```

- `src/app` pages and API routes (thin: parse, authenticate, call a service)
- `src/server/services` business logic and authorization; `src/server/authz/policy.ts` is the single permission policy
- `src/server/db` schema, migrations, client; every query is scoped by `calendar_id`
- `src/lib` pure logic shared by client and server: conflict detection, recurrence, validation, time zones
- `src/components` UI
- `tests` unit, integration (real PostgreSQL) and end-to-end tests

Design documents: `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Going live

- [Deployment guide](docs/DEPLOY.md): environment variables, platforms, Docker Compose, migrations, monitoring
- [Backups and recovery](ops/RESTORE.md): nightly dumps, retention, restore drill, disaster recovery
- [Security checklist](docs/SECURITY_CHECKLIST.md): what is built in, and what to check on your side
