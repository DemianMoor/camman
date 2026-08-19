# 08 — Local Setup

_Last updated: 2026-08-19_

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
- `PROVIDER_CREDENTIALS_KEY` — 32-byte base64 master key for provider-credential encryption at rest (migration 0110). Generate one:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  **Must be byte-identical to the value set in Vercel** — a mismatch means anything encrypted in one environment silently fails to decrypt in the other (e.g. the backfill script, run locally, encrypts against your local value; the deployed app decrypts against the Vercel value).

> `.env.local` is gitignored — never commit it. Never commit populated secrets.

## 3. Seed the staging database (camman-v2)

`db:seed` builds a deterministic dataset on any already-migrated database.
`db:reset` wipes the seed org (cascade) and re-seeds — for when staging has drifted.

Both scripts **refuse to run unless `SEED_TARGET=staging` is set** in `.env.local`.
Add it only for the staging database; never set it on a `.env.local` that points at production.

```powershell
# .env.local — staging only
SEED_TARGET=staging
```

```powershell
npm run db:seed    # first-time seed (idempotent: skips if already seeded)
npm run db:reset   # wipe seed org → re-seed from scratch
```

What gets created:
- Auth user `seed@camman-staging.local` / `SeedPass123!` (trigger creates org + member)
- 1 affiliate network, brand, offer; 1 SMS provider + phone
- 5 creatives (creative 5 has `allow_multi_segment = true` for multi-segment UI testing)
- 1 contact group; 500 generated contacts (`+1555XXXXXXX`)
- 3 campaigns (completed/active/draft), 4 stages, 500 stage_sends
- 14 days of `report_stage_hour` + `report_group_hour` rows so report charts render

Requires `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL` to all be set.

## 4. Database migrations
Migrations are **hand-authored** and **not** auto-applied. Apply them against the `DATABASE_URL` in `.env.local`:
```powershell
npm run db:migrate                                    # drizzle-kit migrate
npx tsx scripts/verify-migration-integrity.ts         # confirm the chain is clean
```
- `npm run db:generate` is intentionally avoided (it blocks on a TTY rename prompt — see project memory). New migrations are hand-written: author the SQL in `db/migrations/`, clone the snapshot forward, add the journal entry, then `db:migrate` + verify.
- `npm run db:studio` opens Drizzle Studio to browse the DB.

> ⚠️ Local dev and production point at the **same** Supabase project today (CLAUDE.md §14). Migrations you apply locally affect prod data. Be deliberate.

## 5. Run the dev server
```powershell
npm run dev
```
Open http://localhost:3000 (or your configured port). The dev server uses Turbopack (Next 16 default).

> If you restart and hit "Another next dev server is already running" on Windows, the prior process didn't die — find and kill it (`taskkill /PID <pid> /F`) before restarting (see project memory).

## 6. First login
- Sign up at `/signup`; verify the email (Supabase sends a link).
- The `handle_new_user()` trigger auto-creates your org + makes you `owner`.
- You land on `/dashboard`.

## 7. Useful scripts (`scripts/`, run with `npx tsx`)
| Script | Purpose |
|--------|---------|
| `verify-migration-integrity.ts` | compare DB-recorded migration hashes vs files (read-only) |
| `backfill-tracking-ids.ts` | idempotent backfill of campaign/stage tracking IDs |
| `backfill-creative-spam-scores.ts` | score existing creatives |
| `verify-mint.ts`, `verify-drain.ts`, `verify-credentials.ts`, `verify-geoip-cache.ts`, `verify-poll-opt-outs.ts`, `verify-brand-domains.ts` | targeted send/link-pipeline checks |
| `test-*-api.ts` | API test suites (need `TEST_USER_EMAIL`/`TEST_USER_PASSWORD` set temporarily against a running dev server) |

## 8. Exercising cron endpoints locally
Cron jobs are plain route handlers. Call them with the Bearer secret:
```powershell
curl.exe -H "Authorization: Bearer $env:CRON_SECRET" http://localhost:3000/api/clicks/score-pending
```
(`/api/opt-outs/poll`, `/api/cron/send-scheduled`, and `/api/keitaro/poll` also accept an authenticated session POST for the caller's own org.)

The Keitaro poll (`*/5`) needs `KEITARO_API_KEY` set (and optionally `KEITARO_API_URL`, default `https://admin.gdkn.org`). With the key unset it returns `degraded:true` and writes nothing:
```powershell
curl.exe -H "Authorization: Bearer $env:CRON_SECRET" "http://localhost:3000/api/keitaro/poll?windowDays=3"
```
Read what landed: `GET /api/keitaro/results?campaign_id=<id>`.

## 9. Build & lint
```powershell
npm run lint
npm run build
```

## Common pitfalls
- **EMAXCONNSESSION / connection exhaustion** in dev — the `globalThis` pool cache in `db/client.ts` exists to prevent this under HMR. Don't remove it.
- **CRLF false positives** in `verify-migration-integrity.ts` were resolved via `.gitattributes` (`db/migrations/** eol=lf`). If they recur, check `git ls-files --eol db/migrations` (see project memory).
- **Click scoring returns 503** — `CRON_SECRET` isn't set. **Scoring `degraded`** — `MAXMIND_LICENSE_KEY` missing/rate-limited (UA-only scoring still runs).
- **Wrong/missing `PROVIDER_CREDENTIALS_KEY`** — the opt-out/DLR pollers skip every credential (a `console.warn` per row, no crash), while the send drain **fails loudly**: `resolveKeyForStage` has no try/catch, so a decrypt/master-key failure throws (surfacing as a 500) — deliberate for a send-path misconfiguration. The backfill script hard-fails at startup if the key is unset.
- **Keitaro poll `degraded:true`** — `KEITARO_API_KEY` unset or the report fetch failed (logged in `error`); retries next cycle. **`matched:0` with `unmatched_samples`** — the `sub_id_3` values Keitaro returns don't match any `campaign_stages.tracking_id` (inspect the samples to see what's actually coming through).
