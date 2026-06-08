# 08 — Local Setup

_Last updated: 2026-06-05_

Clone-to-running on Windows (PowerShell). Adapt paths/shell as needed; the repo lives at `c:\AFF\camman`.

## Prerequisites
- **Node.js** ≥ 20 (devDeps target `@types/node@20`).
- **npm** (lockfile is `package-lock.json`).
- Access to the **Supabase project** (URL, anon key, service-role key, DB connection string).
- Optional for full functionality: classifier service URL+key, MaxMind license key, TextHub credentials, a Telegram bot.

## 1. Install
```powershell
# from the repo root
npm install
```

## 2. Configure environment
```powershell
Copy-Item .env.example .env.local
# then edit .env.local and fill in real values
```
Fill at minimum (see [06-integrations.md](06-integrations.md) for every variable):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL` — Supabase pooler string with `?prepare=false`. **URL-encode `#`/`&` in the password** or rotate to alphanumerics (a `#` silently truncates the connection string).
- `NEXT_PUBLIC_SITE_URL` — set to your local dev origin and keep it consistent with the port you run on (the `.env.example` sample uses `http://localhost:3001`; `next dev` defaults to `3000`).

> `.env.local` is gitignored — never commit it. Never commit populated secrets.

## 3. Database migrations
Migrations are **hand-authored** and **not** auto-applied. Apply them against the `DATABASE_URL` in `.env.local`:
```powershell
npm run db:migrate                                    # drizzle-kit migrate
npx tsx scripts/verify-migration-integrity.ts         # confirm the chain is clean
```
- `npm run db:generate` is intentionally avoided (it blocks on a TTY rename prompt — see project memory). New migrations are hand-written: author the SQL in `db/migrations/`, clone the snapshot forward, add the journal entry, then `db:migrate` + verify.
- `npm run db:studio` opens Drizzle Studio to browse the DB.

> ⚠️ Local dev and production point at the **same** Supabase project today (CLAUDE.md §14). Migrations you apply locally affect prod data. Be deliberate.

## 4. Run the dev server
```powershell
npm run dev
```
Open http://localhost:3000 (or your configured port). The dev server uses Turbopack (Next 16 default).

> If you restart and hit "Another next dev server is already running" on Windows, the prior process didn't die — find and kill it (`taskkill /PID <pid> /F`) before restarting (see project memory).

## 5. First login
- Sign up at `/signup`; verify the email (Supabase sends a link).
- The `handle_new_user()` trigger auto-creates your org + makes you `owner`.
- You land on `/dashboard`.

## 6. Useful scripts (`scripts/`, run with `npx tsx`)
| Script | Purpose |
|--------|---------|
| `verify-migration-integrity.ts` | compare DB-recorded migration hashes vs files (read-only) |
| `backfill-tracking-ids.ts` | idempotent backfill of campaign/stage tracking IDs |
| `backfill-creative-spam-scores.ts` | score existing creatives |
| `verify-mint.ts`, `verify-drain.ts`, `verify-credentials.ts`, `verify-geoip-cache.ts`, `verify-poll-opt-outs.ts`, `verify-brand-domains.ts` | targeted send/link-pipeline checks |
| `test-*-api.ts` | API test suites (need `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` set temporarily against a running dev server) |

## 7. Exercising cron endpoints locally
Cron jobs are plain route handlers. Call them with the Bearer secret:
```powershell
curl.exe -H "Authorization: Bearer $env:CRON_SECRET" http://localhost:3000/api/clicks/score-pending
```
(`/api/opt-outs/poll` and `/api/cron/send-scheduled` also accept an authenticated session POST for the caller's own org.)

## 8. Build & lint
```powershell
npm run lint
npm run build
```

## Common pitfalls
- **EMAXCONNSESSION / connection exhaustion** in dev — the `globalThis` pool cache in `db/client.ts` exists to prevent this under HMR. Don't remove it.
- **CRLF false positives** in `verify-migration-integrity.ts` were resolved via `.gitattributes` (`db/migrations/** eol=lf`). If they recur, check `git ls-files --eol db/migrations` (see project memory).
- **Click scoring returns 503** — `CRON_SECRET` isn't set. **Scoring `degraded`** — `MAXMIND_LICENSE_KEY` missing/rate-limited (UA-only scoring still runs).
