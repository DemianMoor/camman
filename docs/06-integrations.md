# 06 — Integrations & Environment

_Last updated: 2026-06-05_

External services CamMan talks to, their contracts, and every environment variable (**names + purpose only — never values or secrets**). Source: [`.env.example`](../.env.example), `lib/spam/`, `lib/links/`, `lib/sends/`, `lib/alerts/`.

## External services

| Service | Direction | Used by | Auth | Contract |
|---------|-----------|---------|------|----------|
| **Supabase Postgres** | app → DB | everything (Drizzle) | `DATABASE_URL` (pooler, `?prepare=false`) | SQL |
| **Supabase Auth** | app ↔ auth | sign-in/up, sessions | anon key (client), service-role (admin) | `@supabase/ssr` |
| **SMS Spam Classifier** (Cloud Run) | app → service | creative scoring | `X-API-Key` header | `POST {CLASSIFIER_URL}/score` `{text}` → `{score,label?,confidence?,model_version?}` |
| **TextHub** | app ↔ provider | send + STOP inbox poll | per-provider `api_key` (DB, brand-scoped) | send: `GET https://api.texthub.com/v2/?api_key=&text=&number=&lead_id=`; inbox: `?inbox=true` |
| **MaxMind GeoLite2** | app → download | click ASN/country enrichment | `MAXMIND_LICENSE_KEY` | downloads `.mmdb` at runtime |
| **Telegram Bot API** | app → alerts | circuit-breaker / poller alerts | bot token | best-effort `sendMessage` |
| **Vercel Cron** | scheduler → app | the 3 cron endpoints | `Authorization: Bearer CRON_SECRET` | `*/15 * * * *` |

> TextHub gotchas (`lib/sends/texthub.ts`): never pass `long_url` (their rewriter clobbers our tracked link) or `group` (share link — kills per-recipient uniqueness). Their push opt-out callback is broken on their side → intake uses inbox **polling**.

## Environment variables

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | anon key (browser-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server** | bypasses RLS; used by `lib/supabase/admin.ts`. Never expose to browser |
| `DATABASE_URL` | server | Postgres connection (Supabase pooler, `?prepare=false`). URL-encode special chars in the password (`#`/`&`) or rotate to alphanumerics — `#` silently truncates the string |
| `NEXT_PUBLIC_SITE_URL` | public | app origin; auth callback base + absolute links. Must match the deployed origin in prod |
| `SPAM_PROVIDER` | server | which spam provider (`classifier` is the only option) |
| `CLASSIFIER_URL` | server | Cloud Run URL of the classifier service |
| `CLASSIFIER_API_KEY` | server | `X-API-Key` for the classifier |
| `CLASSIFIER_TIMEOUT_MS` | server | classifier fetch timeout (default 10000) |
| `MAXMIND_LICENSE_KEY` | server | GeoLite2 download key; unset ⇒ scoring runs on UA only (asn/country/datacenter NULL) |
| `CRON_SECRET` | server | shared secret for cron endpoints (Bearer). Also gates the send drain. Unset ⇒ click-scoring endpoint returns 503 |
| `SEND_ENABLED` | server | global kill-switch for the send **drain**; must be exactly `"true"` to send. Default OFF; re-checked between batches mid-drain |
| `TELEGRAM_BOT_TOKEN` | server | Telegram alert bot token (best-effort; unset ⇒ silent no-op) |
| `TELEGRAM_CHAT_ID` | server | numeric chat/group id for alerts |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | **local only** | credentials for `scripts/test-*-api.ts`; remove after use |

### Secrets handling rules (CLAUDE.md §11)
- Never commit `.env.local` or any populated secrets; never log secrets or put them in error messages.
- The TextHub `api_key` is **not** an env var — it's stored per provider in `provider_credentials` (multi-tenant), **plaintext at rest** in v1 (protected by deny-by-default RLS + app-layer checks). See [security-notes.md](security-notes.md). Encryption-at-rest / secret manager is deferred.
- Production env vars are set in the Vercel dashboard (Settings → Environment Variables), not via CLI.

## Supabase Auth URL configuration (prod)
Authentication → URL Configuration must include the production origin under Site URL and Redirect URLs (`/auth/callback`, `/auth/complete`, `/auth/reset-password`), keeping localhost entries for dev (CLAUDE.md §14).
