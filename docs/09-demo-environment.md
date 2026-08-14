# External demo environment

_Last updated: 2026-08-14_

A fully separate CamMan deployment for external review: its own Supabase project,
its own Vercel project, the same repository. Zero production data — synthetic
only. Tracked in ClickUp card `869ej81bq`.

| Piece | Value |
|---|---|
| Vercel project | `camman-v2`, production branch `demo` |
| Supabase project | `camman-v2` (`fdzxzxayhknywvmrhjcj`), region `eu-central-1` |
| Branch | `demo` (tracks `main`; rebase it forward, never merge it back) |
| Data | `scripts/seed-demo.ts` only |

## Connection strings (both are needed, and they differ)

Supabase's **direct** host `db.<ref>.supabase.co` publishes only an `AAAA`
record. It is unreachable from IPv4-only networks — most laptops, and Vercel's
build/runtime. A connection string built on it fails with `ENOTFOUND`, which
looks like an outage but is a routing fact. Use Supavisor:

```
# App (Vercel DATABASE_URL) — transaction pooler, per project convention
postgresql://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?prepare=false

# Migrations only — session pooler
postgresql://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
```

Two things change versus the direct host: the port, and the **username**, which
becomes `postgres.<project-ref>` rather than `postgres`.

Migrations run on `:5432`. The whole chain is one long transaction; the
transaction pooler drops it partway through and `drizzle-kit` reports a bare
`exit code 1` with no error text, leaving the database empty. If a migration run
appears to do nothing, check the port before anything else.

## The chain is not replayable from scratch

`db/migrations/0113_enable_rls_system_tables.sql` runs

```sql
ALTER TABLE public.carrier_norm_backfill_snapshot ENABLE ROW LEVEL SECURITY;
```

but **no migration creates that table**. In production it exists because
`scripts/backfill-carrier-v2.ts --apply` created it on demand (see
[03-data-model.md](03-data-model.md)); 0113 then altered it. On a fresh database
the table is absent and 0113 aborts, rolling back the entire chain.

The fix for a new environment is to create it out-of-band **before** migrating,
with the definition the backfill script uses:

```sql
CREATE TABLE IF NOT EXISTS carrier_norm_backfill_snapshot (
  contact_id  uuid PRIMARY KEY,
  carrier_norm text NOT NULL,
  snapped_at  timestamptz NOT NULL DEFAULT now()
);
```

Editing 0113 instead would change an already-applied migration's hash and break
`verify-migration-integrity.ts` against production. The demo database therefore
carries this table out-of-band exactly as production does.

## Why the demo cannot send or call a real API

Every outbound `fetch` in `lib/` is blocked by one of two mechanisms, and the
demo satisfies both.

**Env-guarded** — the call site returns before `fetch` when its key is unset:
Keitaro (`apiKey()` guard on all four call sites — the hardcoded
`https://admin.gdkn.org` default is never reached), Telnyx, MaxMind, Anthropic
carrier-triage, Telegram. These envs are deliberately empty on `camman-v2`.

**DB-credential-gated** — the TextHub, Ahoi and Text Request pollers each select
`provider_credentials` joined to `sms_providers` on a specific key
(`IN ('txh','txh2')`, `= 'ahi'`, `= 'txr'`). Zero matching rows means zero
iterations and zero calls. The two Tells crons (`tells-sweep`, `tells-monitors`)
read only `tells_webhook_events` / `cron_locks` / `stage_sends` and make no
outbound call at all.

This was verified by enumerating **every** `fetch` call site under `lib/` and
classifying each, rather than by spot-checking the jobs — repeat that enumeration
when auditing after new providers land (all 19 `vercel.json` crons were covered
as of 2026-08-14).

The seed keeps the second class empty by construction. Seeded providers use a
**three-block rule**, any one of which alone prevents a dispatch:

1. `sms_provider_id` is **not** in the adapter registry
   (`txh`/`txh2`/`ahi`/`txr`/`tls` — re-check
   [lib/sends/providers/registry.ts](../lib/sends/providers/registry.ts), it grows
   with each provider), so `getAdapter()` raises `UnknownProviderError` → drain
   refuses with `unknown_provider`;
2. `supports_api_send = false`;
3. no `provider_credentials` rows at all → drain refuses with `no_credentials`.

Independently, `runStageDrain` refuses before any transport on `send_approved`
(default false), `SEND_ENABLED !== "true"` (unset on the demo), and
`org_settings.sends_enabled` — which the seed writes as `false`.

**Do not** seed a provider whose `sms_provider_id` is a registry key, and do not
add `provider_credentials` rows. That is the single change that would make an
outbound call possible.

## Basic Auth (`DEMO_BASIC_AUTH`)

[middleware.ts](../middleware.ts) gates the whole deployment behind HTTP Basic
Auth, as a free replacement for Vercel Deployment Protection. It is **inert
unless `DEMO_BASIC_AUTH` is set** (format `user:password`), so production — which
does not set it — is unaffected.

Two behaviours matter:

- **Bearer passthrough.** Vercel Cron authenticates with
  `Authorization: Bearer <CRON_SECRET>` — the same header Basic Auth uses. The
  middleware branches on the auth *scheme* and lets any `Bearer` through;
  each cron route then checks `CRON_SECRET` itself. Without this, all 17 cron
  entries would 401. A path-prefix exemption would not work: cron paths span
  `/api/cron`, `/api/keitaro`, `/api/clicks`, `/api/opt-outs` and `/api/reports`.
- **Public exemptions.** `/r/` (the link shortener — recipients and reviewers
  clicking a seeded link hold no credentials) and `/api/webhooks/` (authenticated
  by their own per-credential path token).

## Seeding

```bash
DATABASE_URL=<demo transaction or session pooler URL> \
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<demo service role key> \
TEST_USER_EMAIL=<demo login> TEST_USER_PASSWORD=<demo password> \
NEXT_PUBLIC_SITE_URL=https://<demo origin> \
npx tsx scripts/seed-demo.ts            # --dry-run runs guards only
```

[scripts/seed-demo.ts](../scripts/seed-demo.ts) deliberately **does not load
`.env.local`**, unlike every other script here: that file holds the production
`DATABASE_URL`, and a seed that picked it up silently would write synthetic
contacts into the live tenant. Pass everything explicitly.

Four guards run before any write, and all four are exercised by negative tests:

1. **Host allowlist** — the connection host must be the demo Supabase pooler and
   the user must be `postgres.<demo-ref>`; both are checked by parsing the URL
   *before* a connection is opened.
2. **Foreign organization** — if any `organizations` row exists that this script
   did not create, abort. Production has exactly such a row.
3. **Domain guard** — no seeded URL may contain a production domain
   (`gdkn.org`), checked statically on `NEXT_PUBLIC_SITE_URL` and again by
   querying the seeded rows afterward.
4. **Already-seeded** — a re-run is a no-op, not a duplicate.

The demo user is created through the **service-role Auth admin API**, not a raw
`auth.users` insert: only GoTrue produces the identity row and password hash that
make login work. The `on_auth_user_created` trigger then creates the organization
and the `owner` membership, so the seed *adopts* that org rather than inserting
one — and renames it to "CamMan Demo".

Seeded shape: 1 org, 1 user, 3 contact groups, 500 contacts on `+1555…` numbers,
2 segments, 1 network, 1 brand, 2 offers, 3 providers, 3 provider phones, 5
creatives, and 3 campaigns (draft / scheduled / completed). The completed
campaign carries a frozen audience pool, two sent stages, per-recipient
`stage_sends`, tracked `links`, `clicks` with a realistic classification mix
(~72% human / suspect / bot / prefetch) feeding `counted_clickers` and the EPC
denominators, plus sales, opt-outs and clickers.

Click IPs use `203.0.113.0/24` (TEST-NET-3), which is reserved for documentation
and is never routable.

## Deliberately absent

Keitaro, Telnyx, Telegram, the spam classifier, MaxMind, Ahoi and Anthropic envs
are all unset. Jobs that need them no-op. One consequence worth knowing:
`/api/cron/telegram-report` treats "unconfigured" as a skip (HTTP 200
`{skipped:true, reason:"telegram_not_configured"}`) rather than a 500, while
still logging at error level — otherwise the demo would emit ~11 spurious 500s a
day. See [04-features/crons.md](04-features/crons.md).
