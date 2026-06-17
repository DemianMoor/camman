# 06 — Integrations & Environment

_Last updated: 2026-06-17_

External services CamMan talks to, their contracts, and every environment variable (**names + purpose only — never values or secrets**). Source: [`.env.example`](../.env.example), `lib/spam/`, `lib/links/`, `lib/sends/`, `lib/alerts/`, `lib/keitaro/`.

## External services

| Service | Direction | Used by | Auth | Contract |
|---------|-----------|---------|------|----------|
| **Supabase Postgres** | app → DB | everything (Drizzle) | `DATABASE_URL` (pooler, `?prepare=false`) | SQL |
| **Supabase Auth** | app ↔ auth | sign-in/up, sessions | anon key (client), service-role (admin) | `@supabase/ssr` |
| **SMS Spam Classifier** (Cloud Run) | app → service | creative scoring | `X-API-Key` header | `POST {CLASSIFIER_URL}/score` `{text}` → `{score,label?,confidence?,model_version?}` |
| **TextHub** | app ↔ provider | send + STOP inbox poll | per-provider `api_key` (DB, brand-scoped) | send: `GET https://api.texthub.com/v2/?api_key=&text=&number=&lead_id=`; inbox: `?inbox=true` |
| **MaxMind GeoLite2** | app → download | click ASN/country enrichment | `MAXMIND_LICENSE_KEY` | downloads `.mmdb` at runtime |
| **Telegram Bot API** | app → alerts | circuit-breaker / poller alerts | bot token | best-effort `sendMessage` |
| **Keitaro** (tracker) | app → tracker | 5-min results poll + 15-min conversions poll + 15-min offer-reach poll | `Api-Key` header | `POST {KEITARO_API_URL}/admin_api/v1/report/build` `{range,grouping,metrics}` → `{rows[]}`; `POST …/conversions/log` `{range,columns,filters}` → `{rows[]}` (per-recipient sales by `sub_id_1`); `POST …/clicks/log` `{range,columns,filters}` → `{rows[]}` (per-recipient offer-page clicks by `sub_id_1`); `GET …/campaigns` |
| **Vercel Cron** | scheduler → app | the 6 cron endpoints | `Authorization: Bearer CRON_SECRET` | `*/15` (×5) + `*/5` (Keitaro results poll) |

> Keitaro gotchas (`lib/keitaro/`): point all calls at the single admin host `KEITARO_API_URL` (default `https://admin.gdkn.org`) — never a brand tracking domain. Group reports by `sub_id_3` + `campaign_id`, where `sub_id_3` carries the **stage tracking id** (not a bare campaign id), so mapping back is `sub_id_3` → `campaign_stages.tracking_id`. The `campaign_id` dimension separates landing-page **visits** (campaign **name** `gk-lp-visits` — its alias is a random code, so match on name not alias) from **offer redirects** — resolve the name → `campaign_id`(s) via `GET /admin_api/v1/campaigns`, never a hardcoded id (rebuild-safe). Keep `admin.gdkn.org` DNS-only / WAF-excepted so the every-5-min calls aren't bot-challenged. The documented grouping/metric keys live in one place (`KEITARO_GROUPING` / `KEITARO_METRICS` in `lib/keitaro/client.ts`) — a wrong key silently returns nothing. **Conversions log** (`conversions/log`, per-recipient sales): returns **only** the `columns` you request and **400s on any unknown column name** (unlike report/build, which silently drops); it also rejects an `order` key (sort in memory). Confirmed columns: `event_id` (unique conversion id, UUIDv7 — the dedup key), `sub_id_1` (= recipient `stage_sends.id`), `status` (`lead`/`sale`/`rejected`, lowercase), `revenue` (NOT `payout` — doesn't exist), `datetime` (ET wall-clock). Pinned in `KEITARO_CONVERSION_COLUMNS`. **Clicks log** (`clicks/log`, per-recipient offer-page reach — Level 2): same `events` report schema / 400-on-unknown-column contract. Confirmed columns: `event_id` (per-click id, dedup key), `sub_id_1` (recipient id), `campaign` (NAME — `gk-lp-visits` ⇒ landing/L1, dropped; any other ⇒ offer/L2), `campaign_id`, `datetime` (ET). Filter `sub_id_1 NOT_EQUAL ""` server-side. Pinned in `KEITARO_CLICK_COLUMNS`.

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
| `SEND_ENABLED` | server | deploy-level **backstop** for the send **drain**; must be exactly `"true"` to send. Left permanently on in Vercel — the day-to-day on/off is the DB flag `org_settings.sends_enabled` (Settings → Sending). The drain requires BOTH. Re-checked between batches mid-drain |
| `TELEGRAM_BOT_TOKEN` | server | Telegram alert bot token (best-effort; unset ⇒ silent no-op) |
| `TELEGRAM_CHAT_ID` | server | numeric chat/group id for alerts |
| `KEITARO_API_URL` | server | Keitaro admin/API host (default `https://admin.gdkn.org`). Never a brand tracking domain |
| `KEITARO_API_KEY` | server | Keitaro Admin API key (`Api-Key` header). Unset ⇒ poll returns `degraded:true` and writes nothing. **Rotate** the key shared in plaintext during setup |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | **local only** | credentials for `scripts/test-*-api.ts`; remove after use |

### Secrets handling rules (CLAUDE.md §11)
- Never commit `.env.local` or any populated secrets; never log secrets or put them in error messages.
- The TextHub `api_key` is **not** an env var — it's stored per provider in `provider_credentials` (multi-tenant), **plaintext at rest** in v1 (protected by deny-by-default RLS + app-layer checks). See [security-notes.md](security-notes.md). Encryption-at-rest / secret manager is deferred.
- Production env vars are set in the Vercel dashboard (Settings → Environment Variables), not via CLI.

## Supabase Auth URL configuration (prod)
Authentication → URL Configuration must include the production origin under Site URL and Redirect URLs (`/auth/callback`, `/auth/complete`, `/auth/reset-password`), keeping localhost entries for dev (CLAUDE.md §14).
