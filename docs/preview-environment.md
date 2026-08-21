# Preview environment (Vercel previews + `camman-v2` database)

_Last updated: 2026-08-21_

Vercel preview deployments of CamMan run against a **separate, disposable Supabase
database**, so a branch can be clicked through without touching production data and
without any possibility of sending SMS.

## What it is

| | Value |
|---|---|
| Supabase project | **`camman-v2`** — ref `fdzxzxayhknywvmrhjcj`, region `eu-central-1` |
| Vercel project it serves | **`camman`** (`prj_1NwxHmBONjLtRXELxXXTzhA3sSQ1`), **preview** target only |
| Production database | `camman` — ref `rtdarhkkjwcetlmruftl` — **never** used by previews |

**This database is shared with the external demo environment** (ClickUp card
`869ej81bq`, see the `demo` branch and `scripts/seed-demo.ts`). The same Supabase
project backs both the `camman-v2` Vercel project (the demo, production branch
`demo`) and preview deployments of the `camman` Vercel project.

That sharing is a deliberate, cost-driven choice with a real consequence: **a migration
applied here for a preview stays applied, and can break the demo.** Before showing the
demo externally, check that no half-finished agent migration has landed. If the demo
becomes something you cannot afford to break, split preview onto its own project
(~$10/month) rather than working around this.

## Where the connection details live

**Never in the repo.** The connection string exists in exactly two places:

- **Vercel** → project `camman` → Settings → Environment Variables → `DATABASE_URL`
  scoped to **Preview only**. This is what preview deployments actually read.
- **Supabase dashboard** → project `camman-v2` → Project Settings → Database →
  Connection string → *Transaction pooler* (port `6543`, `?prepare=false`), if you
  need to reissue it.

Production's `DATABASE_URL` remains scoped to **Production only** and is a different
value. The two are deliberately separate entries; do not merge them back into one
variable targeting both environments.

## Schema parity with production

The preview database is a faithful structural copy of production — verified
2026-08-18:

| | preview (`camman-v2`) | production |
|---|---|---|
| tables | 74 | 74 |
| functions | 8 | 8 |
| triggers | 13 | 13 |
| materialized views | 3 | 3 |
| RLS policies | 129 | 129 |

It holds small synthetic seed data (a few brands, campaigns, stages, creatives,
~500 fake contacts) — enough for the main pages to render — and **zero rows in
`provider_credentials`**.

Note the schema was **not** produced by replaying the migration chain from scratch;
that chain does not currently replay cleanly (migration 0113 depends on a table only
a backfill script creates). Rebuild by copying production's schema, not by replaying.

## Which project applies migrations (and why only one may)

**A preview build applies migrations.** `package.json`:

```
"vercel-build": "if [ \"$VERCEL_ENV\" = \"preview\" ] && [ \"$RUN_PREVIEW_MIGRATIONS\" = \"1\" ]; then npm run db:migrate; fi && next build"
```

So opening a PR that adds a migration is by itself enough to apply it to this database —
nobody has to run anything. That is deliberate (it is what lets a branch be clicked through),
but combined with the demo sharing this database it is also the mechanism by which an
unfinished agent migration reaches the demo. See the warning above.

**`RUN_PREVIEW_MIGRATIONS` exists because TWO Vercel projects build every commit of every PR
against this repo**, and both get `VERCEL_ENV=preview`:

| project | preview `DATABASE_URL` | migrates? |
|---|---|---|
| `camman` | camman-v2 DB (separate `preview`-scoped entry) | **yes** — `RUN_PREVIEW_MIGRATIONS=1` on its Preview scope |
| `camman-v2` | camman-v2 DB (one entry targeting `production,preview`) | no — the variable is not set there |

Before the gate, both raced to `db:migrate` on the one database. Observed on PR #108
(migration 0146): `camman-v2` failed ~0.9s into `db:migrate` while `camman` applied the
migration successfully a minute later; redeploying the **identical commit** then passed,
which is what proved contention rather than bad migration content. Before that PR
`camman-v2` had succeeded on 12 consecutive deployments — it only ever failed when a PR
actually introduced a migration.

`camman` is the project that keeps migrating because its preview is the one a branch is
actually opened on, so it is the one that must have the schema its branch expects.
`camman-v2`'s production (demo) target never migrated anyway — `VERCEL_ENV=production`
fails the first condition — so the demo database has always depended on `camman` previews
for its schema. The gate does not change that; it only stops the second racer.

**The gate is opt-in on purpose.** An unset `RUN_PREVIEW_MIGRATIONS` means *do not migrate*.
A new Vercel project, a fork, or a misconfigured preview will therefore fail loudly on a
missing column rather than quietly migrating a database it should not touch. An opt-out flag
(`SKIP_PREVIEW_MIGRATIONS`) would have made every new environment a migrator by default.

**Keep both conditions ANDed.** `RUN_PREVIEW_MIGRATIONS` is scoped to **Preview only** on
`camman` (narrowed 2026-08-21 21:20 UTC; it briefly shipped as `preview,production`), so
production deploys now fail the check twice over — the variable is absent *and*
`$VERCEL_ENV` is `production`. Two independent guards, neither load-bearing alone.

Do not "simplify" either one away. Dropping the `$VERCEL_ENV` test would make the whole
protection rest on an env-var scope that is edited in a dashboard, with no trace in the repo
and no review; a production deploy running `db:migrate` would violate the rule in CLAUDE.md
§14 that migrations are never auto-applied on deploy.

Verify the scope from the API, not from a build log — behaviour is byte-identical under
either scope (preview migrates, production skips), so no log can distinguish them:

```sh
curl -s "https://api.vercel.com/v9/projects/camman/env?decrypt=false" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | grep -o 'RUN_PREVIEW_MIGRATIONS[^}]*'
```

## Why previews cannot send

Three independent barriers, any one of which is sufficient:

1. `SEND_ENABLED=false` in the Vercel **preview** scope — every send path in the
   codebase gates on `process.env.SEND_ENABLED === "true"`.
2. `org_settings.sends_enabled` is `false` in the preview database (it is `true` in
   production). The send gate is a conjunction of both.
3. `provider_credentials` is empty, and `PROVIDER_CREDENTIALS_KEY` is a dummy value
   in the preview scope, so stored provider credentials cannot be decrypted anyway.

`AHOI_API_TOKEN` is likewise a dummy in the preview scope, so a preview cannot reach
a provider API.

`SUPABASE_SERVICE_ROLE_KEY` is **not** a dummy — it is camman-v2's own service key.
It has to be, together with `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`: auth must target the same Supabase project as the
database. A dummy key pointed at production's Supabase URL would leave the preview
reading camman-v2's data while authenticating against production, so users and orgs
would not match and every page would fail. Scoping all three to camman-v2 is both
more functional and more isolated — the key grants RLS bypass on the disposable
database only, never on production.

## It is disposable (but shared with the demo)

Treat this database as **throwaway**. Nothing in it is a record of anything.

- **Agent-authored migrations may be applied to it freely.** That is one of its main
  purposes: a branch that adds a migration can have it applied here and be clicked
  through before the same migration is ever applied to production.
- It may be wiped and rebuilt from production's schema at any time.
- Do **not** copy production data into it. The value of the seed data is that it is
  synthetic; real contact phone numbers and opt-out records should never land here.

## Autopilot interaction

The CamMan Autopilot posts a preview link in its Review comment only when preview is
genuinely isolated — it checks the Vercel API for a `DATABASE_URL` entry targeting
preview *without* production, and stays silent if it cannot verify that. When a
branch authors a migration, it withholds the link and says which migration needs
applying first, rather than linking a page that would error.

## Known gap — CLOSED 2026-08-21

`public.campaign_circuit_events` had **RLS disabled in production**, as did
`public.contact_org_stats` (migration 0145). Both were oversights rather than decisions —
`send_circuit_events`, the provider-level sibling of `campaign_circuit_events`, has carried
an org-scoped SELECT policy since 0085.

Fixed by **migration 0146** (PR #108): RLS enabled on both, each with a SELECT-only
`org_id = public.current_org_id()` policy and no write policies. The Supabase security
advisor's `rls_disabled_in_public` ERRORs went 2 → 0.

The note above assumed a policy was needed to keep the circuit breaker writing. That was not
the reason: every writer is the server's privileged Drizzle connection (`DATABASE_URL`),
which authenticates as the database role and bypasses RLS, as does `service_role`. The policy
is needed for the org-scoped **reads**, and write policies were deliberately omitted so
anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE entirely.
