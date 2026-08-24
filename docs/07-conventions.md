# 07 — Conventions, Business Rules & Gotchas

_Last updated: 2026-08-24_

## "Made a purchase" has exactly one definition (2026-08-19)

`stage_sends.sale_status` stores the affiliate network's **raw Keitaro postback status**, verbatim. This account's network fires `lead` for PAID conversions and effectively never sends `sale`. Therefore:

- **A buyer is `sale_status IN ('lead','sale')`** — any conversion that was not *rejected*. `rejected` is a refund / chargeback / fraud screen and is never a purchase.
- **The predicate lives in one place**: `purchasedClause()` in [`lib/sale-attribution.ts`](../lib/sale-attribution.ts). Never inline `sale_status = 'sale'` again — that test finds essentially nobody.
- Consumers: the three `made_purchase*` segment rules ([`lib/segment-rules-eval.ts`](../lib/segment-rules-eval.ts)) and the converted tier of the behavioural lanes ([`lib/campaign-tier.ts`](../lib/campaign-tier.ts)).

The reporting surfaces already counted any conversion as a sale — [`lib/keitaro/poll.ts`](../lib/keitaro/poll.ts) does `agg.sales += 1` per conversion row, [`lib/reporting/rollup.ts`](../lib/reporting/rollup.ts) uses `(converted_at IS NOT NULL)`. The targeting side did not, so **the same 854 conversions read as 887 "Sales" on every report and 2 buyers in segments**, and `Clickers excl Buyers` excluded 2 people instead of 837 — i.e. 825 known buyers were being messaged as non-buyers.

⭐ **The lesson generalises: a metric that is displayed and a metric that drives targeting are the same metric.** When a reporting path compensates for a quirk of an external feed, every other consumer of that column must be found and given the same compensation, or the two silently disagree — and the targeting side fails *quietly*, because an under-counted audience still returns rows and still sends.

Guard: [`scripts/verify-purchase-rule-definition.ts`](../scripts/verify-purchase-rule-definition.ts) (read-only; the one write is a synthesized `rejected` conversion inside a rolled-back transaction). It asserts the rule count **equals the live non-rejected-conversion count** rather than a frozen number, so it does not expire as sales accumulate, and it flips a synthesized row `rejected` → `lead` to prove the bar can actually go red.


The authoritative source for project conventions is [`CLAUDE.md`](../CLAUDE.md) at the repo root. This page summarizes the rules a developer most needs and flags every doc↔code discrepancy found while writing these docs.

## Multi-tenancy (non-negotiable)
- Every domain table has `org_id`; **every query filters by it** in app code. A missing filter is a data-leak bug.
- One org-resolution helper per surface (`requireOrgMembership` for pages, `requireApiMembership` for API). Don't invent alternates.
- RLS is defense-in-depth; app-level filtering is primary.
- **Every `public` table must have RLS enabled** (Supabase advisor `rls_disabled_in_public`) — without it the anon key (shipped in the frontend bundle) can read/write it directly via PostgREST. Server-only infra tables with no client caller (e.g. `geoip_cache`, migration `0066`) enable RLS **with no policies**: the direct postgres-js connection (`DATABASE_URL`) and `service_role` bypass RLS, so server code keeps working while anon/authenticated access is default-denied. Tenant tables (those with an `org_id`) need an `org_id = current_org_id()`-scoped policy instead, even when only the server writes them — e.g. `stage_manual_sales` + `opt_out_attributions` (migration `0085`) get a SELECT-only org policy mirroring `stage_sends` (`0050`). Migration `0113` closed the last five stragglers that had shipped with RLS off (`cron_locks`, `report_stage_hour`, `report_group_hour`, `report_refresh_log`, `carrier_norm_backfill_snapshot` — all org-less infra, so no-policy deny-by-default) and switched the `offer_report_campaign_econ` view to `security_invoker = true`. **Run the security advisor (`get_advisors type=security`) after any DDL and drive its ERRORs to zero — see [security-notes.md](security-notes.md).**

## IDs & naming
- **DB id vs business id vs human_id vs tracking_id** are four distinct things:
  - `id` — internal PK (serial / uuid / bigserial).
  - business id (`brand_id`, `offer_id`, `segment_id`, …) — unique user-facing text code on registry tables.
  - `human_id` — user-editable label on campaigns.
  - `tracking_id` — auto-generated, **immutable** analytics id (see below).
- **Tracking ID formats:**
  - Campaign: `<brand_id>_<offer_id>_<MMDDYY>_<seq>` (e.g. `5_14296_051526_1`).
  - Stage: `<campaign_tracking_id>_s<stage_number>_c<creative_id>`.
  - Date is campaign `created_at` in **ET**. **Not lexically sortable across year boundaries — always `ORDER BY created_at`.**
  - Immutable: PATCH rejects changes (`tracking_id_immutable`); changing brand/offer/creative later does not regenerate.
  - **Keitaro `sub_id_3` = the STAGE tracking id** (the offer postfix param carries it into the tracked URL), not a bare campaign id. The Keitaro poll groups by `sub_id_3` + `campaign_id` and maps back via `campaign_stages.tracking_id`; campaign totals are the SUM across stages. See [04-features/keitaro-poll.md](04-features/keitaro-poll.md).
  - **Keitaro `sub_id_1` = the per-recipient id** (= `stage_sends.id`), appended to the tracked link at redirect time for per-sale → phone attribution (conversions poll).
  - **`sub_idN` URL-param vs `sub_id_N` Keitaro-token spelling split (don't mix them up):** the inbound URL param has **no** underscore before the digit (`sub_id1`, `sub_id3`); the Keitaro token / report column / `conversions/log` column has the underscore (`sub_id_1`, `sub_id_3`). The campaign *Parameters* tab maps one onto the other. A mismatch silently breaks attribution (real past bug). Constants: `STAGE_TRACKING_PARAM = "sub_id3"` ([lib/stage-url.ts](../lib/stage-url.ts)), `RECIPIENT_SUB_ID_PARAM = "sub_id1"` ([lib/links/resolve-click.ts](../lib/links/resolve-click.ts)).
  - **Keitaro visit/redirect classification:** clicks are classified by the Keitaro campaign **name** `gk-lp-visits` (landing-page **visits** = "Clickers") vs **any other** campaign (**offer redirects**, whose conversions are sales). Match on **name, not alias** — in the live panel `gk-lp-visits` is the campaign's *name*; its *alias* is a random code (e.g. `ZttBSV`). Resolve the name → `campaign_id`(s) once, then classify rows by `campaign_id`; never hardcode the id (rebuild-safe). Funnel: Clickers → Offer Redirect → Sales, where visits ⊇ redirects (every redirect is also a visit) and the two are **never summed** — total arrivals = visit count. Headline numbers are the **clean** (bot/prefetch-filtered) counts.
- API route naming: `[parentEntityId]` for nested API segments, `[id]` for page routes (avoids Next's sibling-dynamic-segment prohibition).

## Timezone (ET everywhere)
- Single project timezone `CAMPAIGN_TIMEZONE = "America/New_York"`, label `"ET"` ([`lib/campaign-timezone.ts`](../lib/campaign-timezone.ts)). No per-user/per-org timezones yet (would mean editing one file).
- Storage UTC `TIMESTAMPTZ`; API fields are ISO 8601 with offset (`z.string().datetime({ offset: true })`).
- Display via `formatCampaignDateTime(utc)` — **never** bare date-fns `format()` on a campaign timestamp (renders in browser zone).
- Forms: `<input type="datetime-local">` ↔ `campaignLocalInputToUtcIso()` / `utcToCampaignLocalInput()`.
- Send windows evaluated in ET via `lib/quiet-hours.ts` — sender-zone, not recipient-zone (known TCPA limitation).
- **The Telegram performance report is the one place two zones coexist — keep them independent.** `/api/cron/telegram-report` schedules by **`Europe/Warsaw`** (when to send) but buckets all stats by **ET** (which day). Both are derived separately from `new Date()` via `Intl`/`date-fns-tz` `formatInTimeZone` — **never** offset arithmetic, because the Warsaw↔ET gap shifts (5/6/7h) on DST-transition weeks. "Delivered" in the opt-out ratio means **provider-accepted** (`stage_sends.status='sent'`), not DLR-confirmed delivery — CamMan polls no DLR (CLAUDE.md §12).
- **postgres-js timestamptz-inference gotcha:** binding a bare ET wall-clock string and casting `${s}::timestamp` (or `::timestamptz`) lets postgres-js infer a `timestamptz` parameter and **pre-shifts the instant** (a silent multi-hour error). To convert an external ET wall-clock (e.g. Keitaro's `datetime`) to the correct UTC instant, build a zoned literal instead: `(${s} || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz` — concatenation forces text binding; NULL concat → NULL. (Seen in `lib/keitaro/poll-conversions.ts`.)
- **Filter "today in ET" with a sargable UTC range, never a function on the column.** `(sent_at AT TIME ZONE 'ET')::date = today` wraps the indexed column in a function, so no index can serve it — it scans the whole partition. Use `campaignDayBoundsUtc()` ([`lib/campaign-timezone.ts`](../lib/campaign-timezone.ts)) to get the ET-day `{start, end}` UTC instants and filter `col >= start AND col < end` (half-open, DST-safe). Fixed the `<SendStateStrip>` `sent_today` count that ran on **every** page: ~190 ms (full index scan of the org's send history) → ~20 ms (narrow range scan). See `lib/sends/send-state.ts`.
- **TextHub inbox `received_at` is US Mountain Time, not UTC.** TextHub stamps inbound STOP messages "YYYY-MM-DD HH:MM:SS" with no zone in Mountain wall-clock (operator-confirmed). `parseProviderReceivedAt` ([`lib/sends/poll-opt-outs.ts`](../lib/sends/poll-opt-outs.ts)) interprets it in `America/Denver` (`TEXTHUB_RECEIVED_AT_TIMEZONE`, via `date-fns-tz` `fromZonedTime`) → true UTC; DST-aware (MDT/−6 summer, MST/−7 winter). ISO strings that carry their own offset are honored as-is. Parsing it as UTC (the original bug, fixed 2026-06-19) put the attribution anchor up to 7h early, so a campaign's own STOP replies failed the `sent_at <= anchor + 5min` upper bound and the stage's opt-out counter read 0 despite ~100 real replies. Empirically: our ingest clock ran a constant ~6h ahead of the stamped value (132 msgs, June/MDT).

## Money
- `NUMERIC(12,4)`, displayed `$`.
- **Revenue source of truth = `keitaro_stage_results.revenue`** (the real summed per-conversion payout pulled from Keitaro at sync time). Every reported/stored revenue & earnings figure — `/reports`, the dashboard stats + daily-activity charts, the campaign detail per-stage + rollup, the creatives EPC — SUMs this column for the relevant stages/date range. **Never compute revenue as `sales × offers.payout_cpa` (or `× sales_payout_each`).** A network that changes a CPA mid-flight (e.g. Kinzeno 14508 went $60→$66→$75 on 2026-06-23) would otherwise retro-misprice every prior sale. `offers.payout_cpa` is a **current-rate cache** only; `sales_payout_each` survives solely as the manual-results form's pre-save, clearly-labeled *estimate* while typing a sales count (never persisted or shown as actual revenue). `keitaro_stage_results.payout_at_conversion` (= `revenue/sales`, frozen at sync) records the per-unit rate that was actually paid.
- **Attribution basis = CONVERSION DATE (`ATTRIBUTION_BASIS = 'stat_date'`).** Defined once in [`lib/reporting/attribution.ts`](../lib/reporting/attribution.ts); every query that groups/filters **sales or revenue** by date routes through its helpers so they all agree with the `/reports` UI. Sales & revenue are dated by **when the conversion happened, not when the SMS went out** (conversions lag sends — a sale on Jun 23 can come from a Jun 21 send, which is why "by send day" and "by conversion day" disagree). Specifically: **revenue** + **Keitaro sales** → `keitaro_stage_results.stat_date` (already an ET calendar day — the poll queries Keitaro in `America/New_York`); **manual sales** → the `stage_manual_sales` ledger **entry date** (`created_at`, bucketed ET). Per stage the two sales sources combine with `combineSales` (max, not sum — a Keitaro-tracked + manually-tallied sale is the SAME sale). Send-day metrics (SMS volume, cost/spend, opt-outs, clickers) stay bucketed by the stage's effective send date. **ROI mixes windows by design** — revenue is conversion-dated, spend is send-dated; a single day's ROI compares partially-different cohorts, but the lag washes out over any steady multi-day period (spend has no conversion date). See [`lib/reporting/attribution.ts`](../lib/reporting/attribution.ts).
- **CPA history (`offer_payouts`):** the offers create/update path writes effective-dated rows — on a CPA change it closes the current row (`effective_to = now()`) and opens a new one rather than overwriting, so the rate timeline is auditable. A partial unique index allows at most one open (`effective_to IS NULL`) row per offer.
- **Stage `total_cost`** (migration `0081`, [`lib/stages/total-cost.ts`](../lib/stages/total-cost.ts)) auto-derives as `cost_per_sms × (sends + opt_out_count)` from the stage's assigned provider phone — opt-out replies count toward the multiplier because STOPs are billed like sends. `sends = GREATEST(sms_count, accepted stage_sends)` so API/tracked stages (where `sms_count` stays 0 and the real dispatched count lives in `stage_sends` `status='sent'`) cost on their actual messages, not just opt-outs. The cost is **gated on the send**: `$0` until `sent_at` is set or `sms_count > 0` (hand-entered results), so a freshly-created/scheduled stage shows no cost. Recomputed wherever those inputs change (manual-results save, opt-out poller, provider-phone PATCH). `total_cost_manual=true` (operator override via the manual-results **Auto-calculate** switch, or a cost-bearing CSV import) freezes the value — the auto formula then leaves it alone.

## Database & migrations
- Drizzle schema in `db/schema.ts`; migrations **hand-authored** SQL in `db/migrations/` (db:generate blocks on a TTY rename prompt — see memory). Hand-write SQL + clone the snapshot forward + add the journal entry, then `db:migrate` + `verify-migration-integrity`.
- Migrations are **not** auto-applied on deploy — run them locally against the target `DATABASE_URL` before pushing dependent code.
- Soft-delete via `status='archived'` + `archived_at`; hard delete is rare and explicit (confirm before any DROP/DELETE/force-push).
- Connection: Supabase **transaction pooler (port 6543)** + `?prepare=false`; `db/client.ts` caches the pool on `globalThis` (don't strip).

## Performance (query & bundle)
- **Substring phone search is trigram-indexed** (migration `0088`). List-view search is `ILIKE '%digits%'`; a plain btree can't serve a leading wildcard, so `contacts`/`opt_outs`/`opt_ins`/`clickers` carry `pg_trgm` GIN indexes on `phone_number` (`extensions.gin_trgm_ops`). Contacts search + its `COUNT(*)` went from a ~820 ms seq scan (752K rows) to ~3 ms. Don't reintroduce a search predicate a trigram index can't use. See [03-data-model.md](03-data-model.md).
- **Sargable "today in ET" ranges** — see the Timezone section's `campaignDayBoundsUtc()` note. Never wrap an indexed timestamp in a function to bucket by day.
- **Baseline harness:** `scripts/perf-baseline.ts` runs `EXPLAIN ANALYZE` (median of N) on the hot list-search + send-state queries and reports the scan node type (Seq Scan = will degrade). Run before/after any query-shape or index change on the large tables.
- **Heavy client deps load on demand.** Recharts (~340 KB, the single biggest chunk) is imported via `next/dynamic({ ssr:false })` in the dashboard ([`components/dashboard/chart-panel.tsx`](../components/dashboard/chart-panel.tsx)) so it stays off the landing page's initial bundle. `next.config.ts` sets `experimental.optimizePackageImports` for `lucide-react`/`date-fns`/`recharts`/`radix-ui` (barrel → deep imports). Add new chart/heavy-widget code behind `dynamic()`, not a static import.
- **CSV export routes set `maxDuration = 60`** — they stream chunked offset-paginated queries over a whole audience; without the cap a large export can outlast the default Vercel budget and get killed mid-stream (silently truncated file).
- **A stuck `sending` row is NEVER auto-re-sent (at-most-once).** A `stage_sends` row can be stranded in `sending` after TextHub already accepted the message (the drain process died before recording it), so re-dispatching it would double-text. The reconciliation pass ([lib/sends/reconcile-stages.ts](../lib/sends/reconcile-stages.ts), run each `send-scheduled` tick) only marks such rows `failed` (terminal) — and only when the stage has been idle past a 15-min stale threshold, safely beyond the 300s drain `maxDuration`, so a live drain is never disturbed. Deliberate re-sending is a human action (retry-failed). Correspondingly, **stage cost is billed from `status='sent'` rows (not `sent_at`)** and **a stage that sent anything reads Green** (failed/stuck rows are a warning via `stageSendWarningCount`, not a whole-stage failure) — so an interrupted-but-mostly-sent stage shows its true cost and status.
- **Every `ORDER BY` on a list endpoint needs a unique tiebreaker.** Append `asc(<table>.id)` to *every* branch of an order-by, including the default one. Bulk-create commits a whole batch in one transaction, so many rows share a `created_at` **to the microsecond** (7 active creatives in this org do); without a tiebreaker Postgres may order within a tie group differently per plan, and a paginated list can then show one row on two pages and skip another entirely. This bit [`/api/creatives/list`](../app/api/creatives/list/route.ts), whose ratio and `spam_score` branches had the tiebreaker but whose default branch did not — fixed 2026-07-30.
- **Cache expensive aggregates on READS, not on a timer.** A refresh cron burns DB time whether or not anyone is looking — that is exactly how `report_stage_hour` became the #1 query by total DB time in this database while having zero readers. Prefer a read-driven cache with a TTL ([lib/creatives/metrics-cache.ts](../lib/creatives/metrics-cache.ts) is the reference: module-level, keyed by `org_id`, single-flight, injected into SQL as a `VALUES` relation so server-side sorting/pagination over the derived values is preserved). An unused read-driven cache costs exactly nothing, so it cannot become a dead rollup. Reach for a table + cron only when the value must be fresh for something no request triggers.
- **Before adding an index to "fix" a slow aggregate, measure it.** Build the candidate inside a transaction and `ROLLBACK` — nothing persists, and prod answers the question honestly. For the creatives metrics aggregate the obvious `links(creative_id)` came out **worse than no index at all**, because the query has no selective predicate: it must touch every click in the window. Indexes buy selectivity; if there is none to buy, the answer is to stop recomputing, not to index.
- **Expensive derived columns need an opt-out, and callers that don't render them must use it.** `/api/creatives/list` computes 30-day CTR/EPC via an org-wide aggregate over the whole `links` table (~2.5 s, ~240 MB of physical reads per call, *independent of how many rows are returned* — the aggregate isn't restricted to the page, so `LIMIT` can't prune it). The stage form's creative dropdown renders none of it, so it passes `include_metrics=false` (~2.5 s → ~3 ms). The flag **defaults to `true`** so existing consumers are unaffected, and when off the `metrics` key is **omitted entirely rather than zero-filled** — a 0% CTR is a claim, absent is the truth. Before adding a derived aggregate to a list endpoint, check whether every caller actually renders it.
- **`parseListParams` clamps `pageSize` to 100 — silently.** Requesting more is truncated with no error, so a caller asking for 200 and rendering "everything it got" quietly hides rows (the stage creative picker did exactly this). Endpoints whose callers legitimately need a whole bounded set pass `parseListParams(req, { maxPageSize })`, and the client must compare `data.length` against `totalCount` and **tell the user** when it was clipped.
- **Large list counts are capped, not exact.** An exact `count(*)` over an org's contacts is inherently O(rows) (~670 ms at 752K — an index doesn't help, proven). `/api/contacts/list` counts at most `COUNT_CAP+1` (10,000) via a `LIMIT` subquery: exact under the cap, `countApprox:true` + `totalCount:COUNT_CAP` (UI shows "N+") over it. Paging no longer depends on the total — the page query fetches `pageSize+1` and returns `hasMore`, which drives `DataTable`'s Next button (optional `hasMore` / `totalCountApprox` props; omit them and a list keeps exact-count `of Y` behavior). Narrowing filters (search, segment, group, the opt-out/in/clicker views) return under the cap, so their counts stay exact. Apply this pattern to any other list that grows large; don't reintroduce an unbounded `count(*)`.

## Brand short domains are LIST-shaped — there is exactly one write surface, and no brand-wide mutation

Migration `0136` let a brand hold several short domains. The write path was not updated with it, and both halves of the old `applyBrandShortDomain` helper became wrong:

1. It ended in `INSERT … ON CONFLICT (brand_id) DO UPDATE`, but `0136` **dropped `short_domains_brand_id_uniq`** — the index that conflict target infers from. Postgres refused to plan the statement (`42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification`), so **saving a brand's short domain 500'd in production from the day 0136 landed**.
2. Its clear branch ran `DELETE … WHERE org_id = … AND brand_id = …`, which post-0136 deletes **every** domain of that brand rather than the one being removed — including a `pending` row provisioned for a later activation.

Neither was noticed because `scripts/verify-brand-domains.ts`, the guard that covered exactly this, had been **red on `main` since that merge and nobody re-ran it**. The lesson generalizes: *a migration that changes a cardinality assumption must re-run the guards that encode it* — see the retire-obsolete-assertions rule.

**A one-to-many child turns every JOIN into a fanout risk.** The same migration that broke the write path also broke a READ: `/api/brands/list` carried `.leftJoin(short_domains, …)` whose one-row-per-brand property rested on the very index `0136` dropped, with a comment saying so. From that merge on, a brand with two domains came back **twice** — so it appeared twice in every brand dropdown in the app (nine consumers share that endpoint), `data.length` disagreed with the separately-counted `totalCount`, and `LIMIT/OFFSET` paged over duplicated rows so a brand could vanish from a later page. Fixed with `leftJoinLateral(… LIMIT 1)`, which makes the cardinality **structural** rather than dependent on an index that can be dropped again. Two rules fall out: **when a UNIQUE constraint is dropped, grep for every join that relied on it** (a comment citing the index is a find, not reassurance), and **prefer LATERAL … LIMIT 1 over a plain join for a "one child row" column**. A correlated sub-select is not a substitute in a single-FROM-table query — Drizzle renders `${brands.id}` as a bare, unqualified `"id"` that binds to the sub-select's own table and silently returns NULL; LATERAL adds the second relation that makes the correlation legal. Pinned by `scripts/verify-brand-list-no-fanout.ts`, which hits the real endpoint and **refuses to pass unless a brand with 2+ domains actually exists** (otherwise "appears exactly once" is vacuous).

**A list column that feeds logic must carry the same value the send path resolves.** The old join had **no status filter at all**, which was harmless while every row was active and became wrong the moment B1 introduced `pending`: the column feeding the campaign form's SMS preview could hand it a host that can never be minted. It now selects the EFFECTIVE domain — active only, explicit default first, then oldest — matching `resolveShortDomainForSend`'s brand-level precedence, and the guard asserts that agreement per brand rather than merely that a row came back.

**The rules now:**
- **One write surface.** `/api/brands/[id]/short-domains` (+ `/[domainId]`). The brand form's single "Short domain" text field is **removed** — a list cannot be expressed in one field — and `POST/PATCH /api/brands` no longer touch `short_domains` at all; the `short_domain` key is **dropped** from the update payload rather than applied, so a stale client cannot reach a second path.
- **Add always lands `pending`.** A newly registered hostname has not been proven to route to the app. Conflict target is `(org_id, domain)` — the unique that still exists — and a conflict is **REFUSED** ("already registered to *brand*"), never `DO NOTHING` or `DO UPDATE`: silently adopting a hostname another brand registered would move that brand's minting.
- **Every mutation is keyed on the domain row's id.** Activate / deactivate / set-default / delete all take an id. **There must never be a brand-wide DELETE again** — `scripts/verify-brand-domains.ts` asserts at *source* level, repo-wide, that no `DELETE FROM short_domains` whose predicate mentions `brand_id` exists anywhere, plus a self-test proving that scanner can actually see a violation. (The probe string is assembled from parts, because written as one literal it made the guard file its own offender — a scanner right about the bytes and wrong about the meaning.)
- **Deactivating clears `is_default`,** and set-default refuses a non-active row. A pending domain as brand default would mean activation silently redirects the whole brand's minting; activate and choose are two deliberate acts.
- **Delete keeps the minted-links guard**, now scoped to the single row: a domain with minted links can only be deactivated, never removed, or its links are orphaned.

## The tracked link is built ONCE — the host is inside the counted body (B2)

`https://<host>/r/<code>` sits **inside** the SMS body that gets counted, so any disagreement about which host wins silently moves the GSM-7 segment boundary. `gdkn.org` is 8 characters and `g.guidekn.com` is 13: the same creative can preview as one segment and send as two — at double the cost, with nothing on screen to show it.

Before B2 the string was built in two places that disagreed twice over:

| | stage form (preview) | kickoff (send) |
|---|---|---|
| host | `campaign.brand.short_domain` — **brand only**, blind to the stage's per-number override | `resolveShortDomainForSend` — override first |
| code length | the literal `"XXXXXXX"` with a comment promising it equalled `CODE_LENGTH` | `"X".repeat(CODE_LENGTH)` |

**The rules now:**
- **[`lib/links/tracked-link.ts`](../lib/links/tracked-link.ts) is the only place a tracked link is constructed** — `buildTrackedLinkUrl(domain, code)` and `buildRepresentativeTrackedLinkUrl(domain)`. It is PURE and CLIENT-SAFE on purpose: `mint-link.ts` pulls in `node:crypto` + `nanoid` and so cannot be imported from a `"use client"` component, which is exactly why the form hardcoded its own copy of the length. `TRACKED_CODE_LENGTH` lives there and `mint-link.ts` imports it, so the generator and every estimate move together. A promise in a comment is not a constraint.
- **`pickEffectiveShortDomain` is the only place the precedence is expressed** (number override > brand default > oldest active). The server resolver runs the DB lookups and then calls it; the stage form receives both candidates over the API and calls the same function. Ranking lives in one function so the two data paths cannot disagree about the winner.
- **Every candidate must be `status='active'` before it is ranked.** A pending host is never mintable, so it reaches the ranker as `null` rather than as something to rank.
- **Any API field feeding a preview must resolve by the SAME rule as the send path.** The campaign-detail `brand.short_domain` subquery ordered by `created_at` alone and ignored `is_default`; it now orders `is_default DESC, created_at, id`, matching the resolver's brand branch. The provider-phones list gained `short_domain` — the number's own override resolved to a string, active-only — because without it the preview could not see the override at all.
- **Regression bar, pinned by [`scripts/verify-b2-segment-length.ts`](../scripts/verify-b2-segment-length.ts):** every `stage_sends.rendered_text` row since the adapter_code cutover must re-derive **byte-identical** through the new builders (29,917/29,917 at the time of writing, segment distribution unchanged), a host change must alter the body by **exactly** the domain substring, and preview and send path must resolve the same domain for every tracked stage. The harness carries **three fault injections** — a corrupted host, a length-sensitivity probe, and a wrong preview candidate — because a green run is only evidence if the harness can go red.

## The opt-out footer is a CHAIN, and the compliance gate validates the WINNER (Q3)

Precedence, most specific first — one function, `resolveOptOutFooter` ([lib/sends/opt-out-footer.ts](../lib/sends/opt-out-footer.ts)):

| Level | Source | Added |
|---|---|---|
| number | `provider_phones.opt_out_footer` | migration 0141 |
| account | `sms_providers.opt_out_footer` | migration 0138 |
| stage | `campaign_stages.stop_text` | what shipped before Q3 |
| floor | `'Stop to END'` | built-in |

- **The creative is deliberately NOT in the chain** — copy and compliance text stay apart.
- **`descriptor.defaultOptOutFooter` is a UI seed/suggestion, never a runtime candidate.** Its only runtime role is as the reference text when validating a provider that appends its own footer — a check, not a choice.
- **`descriptor.appendsOwnOptOut` out-ranks every candidate**: CamMan then appends *nothing*, because two opt-out instructions in one message is worse than either alone. `buildStageSms` omits the footer line entirely rather than leaving a trailing blank line. No adapter sets the flag today — the mechanism ships, the values do not.
- **A whitespace-only field states no preference** and falls through. Treating it as a value would ship a message whose opt-out line is invisible.

**⚠️ THE GATE'S SUBJECT IS THE TEXT THAT SHIPS.** Before the chain existed, the rendered body always carried `stop_text`, so "check the body" and "check `stop_text`" were the same thing. They are not any more. `optOutGateSubject` returns the rendered body when CamMan appends, or the provider's **known** appended text when the provider does — and reports `verifiable: false` when a connection type claims to append but declares no known wording. **Unverifiable fails CLOSED, for every provider, with no dry-run carve-out**: the carve-out exists for a stage whose own wording is missing, which an operator can fix by editing text; there is no operator fix for "this type says it appends something we have never seen". Pinned by `scripts/verify-q3-optout-footer.ts`, which proves a *compliant stage field cannot rescue a non-compliant winning footer* — exactly the hole a field-based gate would leave.

**The number level is editable (per-number footer UI).** `provider_phones.opt_out_footer` shipped with 0141 and had no UI for two phases — the chain's most specific slot existed but nothing could fill it. It is now a field on the number's Edit dialog, built on the **short-domain-override pattern**: leaving it empty INHERITS, and the inherited value is **shown** (as the placeholder, with the account's name) rather than implied. The description names which level currently wins and what happens if the operator types something. When the connection type appends its own wording the field is disabled and says so, because nothing stored anywhere would be sent.

`""` and whitespace mean **no preference**, never an empty footer — an empty box submits `null` so the column clears and the chain falls through. Storing `""` would read as set and behave as unset.

**The preview names the winning level.** The stage form composes from the resolved footer and, when the stage level loses, says which level won and what text will ship. An operator editing a box whose value will never appear on the wire is the failure this surfaces.

## Brand → sending number (Drip Phase 1 item 1a) — WRITE-TIME ONLY, and grandfathered

A stage's `provider_phone_id`, and a campaign's `default_provider_phone_id`, must be a number
registered to **that campaign's brand**. A Guide Kin campaign may not send from a LumZen number.
The rule lives in one place — [lib/api/brand-number-guard.ts](../lib/api/brand-number-guard.ts)
(`checkPhoneBrandMatch`) — and is called from five write paths: campaign POST/PATCH, stage
POST/PATCH, and stage **duplicate**. Error code `phone_brand_mismatch`; the message names the
number and BOTH brands.

- **Enforced on WRITE only — never at send, and never as a DB constraint.** This was an explicit
  product ruling (2026-08-21), not an oversight. 16 existing stages already pair phone 114
  (`+18449903688`, a LumZen number) with campaigns of both brands, three of them carrying 33,578
  materialized `stage_sends` rows scheduled to dispatch. Blocking at send time would strand real
  messages; a DB CHECK would make those rows unwritable and break unrelated edits. The audience
  for this rule is the operator choosing a number, not the drain.
- **GRANDFATHERED via `pairIsChanging`.** UPDATE paths only validate when the patch actually
  changes the brand or the number — `undefined` (absent from the patch) is not a change; an
  explicit `null` is. An existing mismatched stage or campaign stays fully editable (rename,
  reschedule, change creative) as long as the pair itself is untouched. Re-validating an
  untouched legacy pair would turn a targeted rule into a blanket edit-lock on four active
  campaigns.
- **CREATE paths are not grandfathered**, and that includes **stage duplicate** — a duplicate
  makes a new stage, so copying a legacy mismatched stage would mint new mismatches indefinitely
  and make the check decorative. This is the one place the rule changes an existing habit:
  rolling a daily campaign forward by duplicating yesterday's stage now fails until the campaign
  has a number of its own brand.
- **ABSENT = ALLOWED, twice over** — the same shape as the per-number carrier policy above:
  no number chosen ⇒ nothing to check; campaign has no brand yet ⇒ nothing to match against
  (drafts save with zero required fields); **the NUMBER has no brand ⇒ treated as shared, usable
  by any brand.** The last is inert today (all 37 active numbers carry a `brand_id`) but is the
  only safe reading — a NULL brand on a number must never mean "matches nothing", which would
  mute the number entirely.
- **The pickers are an affordance, not the enforcement.** Both list endpoints take an optional
  `brand_id` (`/api/provider-phones/list` for the campaign default; `/api/providers/[id]/phones`
  for the stage picker) returning the brand's own numbers **plus** shared ones. Omitting the
  param is unchanged org-wide behaviour, which the segment-rules editor still relies on to label
  rules across every brand. The API is what rejects; the filter just stops the operator picking
  something that would be rejected.
- **This does NOT constrain which credential a number sends through.** `resolveKeyForStage`
  resolves purely via `provider_phones.credential_id` and never reads the phone's `brand_id`, so
  a number tagged to brand A but bound to brand B's provider account still passes this check.
  Today that pairing exists (phone 114 → credential 565, LumZen's Text Request account) and
  1a closes it for Guide Kin only as a side effect of the number being LumZen-tagged. If
  credential↔brand alignment matters, it needs its own check.
- Guard: [scripts/test-brand-number-guard.ts](../scripts/test-brand-number-guard.ts). It asserts
  **both directions** against the real production mismatch (a guard that rejected everything, or
  allowed everything, would pass a one-sided test), proves the shared-number case against a
  synthesized-then-rolled-back row, and **exits non-zero if the legacy mismatch is ever cleaned
  up** rather than passing on an empty world. It also carries the **rebrand rule** below: a
  synthesized campaign is moved between two brands inside a rolled-back transaction and the SAME
  stage is asserted clean before and stale after, so a `isStageNumberBrandStale` that always
  answered the same way fails. Live rows are never mutated — per the fixture rule below.

## Per-number carrier policy (Q4, migration 0142) — absent row means ALLOWED

`phone_carrier_limits` is an **exception list**, not an allow-list in the "only these are permitted" sense. One row per `(number, carrier)`:

| State | Meaning |
|---|---|
| no row | allowed, uncapped |
| `allowed = false` | this carrier is excluded from this number's audience |
| `daily_limit = NULL` | uncapped |
| `daily_limit = N` | at most N sends per **ET calendar day** (Q5) |

**Absence must never be read as denial.** The clause is written as an anti-join (`NOT EXISTS` a disallowing row) precisely so an empty table is a no-op; a membership test would mute every number in the org the moment the table shipped. The empty-table no-op is itself an acceptance test in `scripts/verify-q4-carrier-allowlist.ts`.

- **Enforced at MATERIALIZATION, never as a skip at drain.** An excluded contact must not become a `stage_sends` row: a row that exists but is skipped later still appears in reconciliation, in the pool/attempted arithmetic, and in the operator's sense of who the stage is for. The audience is where to say no.
- **Every send-path recipient query must pass the policy** — kickoff, preflight, the preflight breakdown, and the **CSV export**. The export especially: an exported row is a manual send, so omitting the policy there would route the restriction around itself. Asserted at source level by the guard.
- **The campaign-level `carrier_filter` and the per-number allow-list AND together.** They are different questions — the campaign filter is frozen into `campaign_audience_pool` at activation and says *who the campaign is for*; the number policy is evaluated live at materialization and says *what this number may carry*. Each can only narrow, so order is irrelevant, and a campaign selecting a carrier the number forbids yields an **empty** audience (the number's NO wins). Proven in the guard.
- **`allow_unknown_carrier` (on `provider_phones`, default true) covers all three unknown-ish buckets together** — `Unknown` (looked up, undetermined), `Unmapped` (awaiting an admin mapping) and `Unidentified` (never looked up). They stay **distinct in the data** because they mean different things for reporting and for the lookup pipeline; they are **one switch in the UI** because the operator's question is only ever "may this number text people whose carrier we do not know?". A NULL `carrier_norm` is treated as unknown — we cannot demonstrate the carrier is permitted. Never default this to false: unknown must never silently suppress.
- **Exclusions are reported per carrier** in the preflight breakdown (`excluded.carrier`), not as one total — "excluded 4,102" is unactionable, "excluded 4,102 Verizon" is not.
- **One write surface, one transaction.** The policy rows and `allow_unknown_carrier` are edited together on the number's Edit dialog and land in a **single `PATCH`** that writes the column and replaces the rows inside one `db.transaction`. A split write can save the toggle while the allow-list fails, leaving a number in a state the operator never chose. `carrier_limits` is **replace-all**: the payload is the number's complete desired policy, so a carrier omitted from it ends with no row — and no row is what "allowed and uncapped" means. Rows that neither deny nor cap are dropped before insert, so counting rows still answers "is this number configured?".
- **The carrier vocabulary is closed and DB-owned.** `CARRIER_NORMS` mirrors the `carrier_mappings_carrier_norm_check` constraint, and the guard asserts the two still agree — a widened constraint would otherwise leave the UI unable to express a policy for the new carrier, silently. `NAMED_CARRIERS` (the individually-toggleable ones) is that list minus the unknown buckets.
- **A source guard names a FILE; only the route proves it is the SCREEN.** The AND-statement guard first pointed at `components/campaigns/campaign-form-fields.tsx` and passed — while both campaign routes render `campaign-editor-page.tsx`, which carries its own copy of the carrier filter. `CampaignFormFields` is **dead render code** (`campaign-form.tsx` is imported only for its `AudienceFilters` type), so the sentence sat on a screen no operator can reach behind a green check. It was caught by opening the page. Any guard asserting user-visible copy must also assert the **route → component** link, as this one now does.
- **The AND statement appears on BOTH screens, and that is asserted.** The campaign audience form and the number's Carrier policy section each say the two filters combine with AND and that neither widens the other. An operator meets the two controls on different days, and the failure mode of not knowing they compose is an empty audience with no visible cause. Source-guarded on both files.

## Per-carrier daily caps are ET CALENDAR days with a bounded overshoot (Q5, migration 0143)

`phone_carrier_limits.daily_limit` is the most messages one NUMBER may send to one CARRIER in a day. Five properties, all deliberate:

- **The day is an ET CALENDAR day, not a rolling 24 hours.** It resets at midnight `America/New_York` rather than decaying gradually. This is *not* the same thing as the existing `rate_24h` ceiling — that is a **rolling throughput** limit on the provider **account**; this is a **per-number, per-carrier allowance**. They coexist and keep **separate `stopReason`s**, because reporting one as the other sends an operator to the wrong control.
- **Checked ONCE PER BATCH, at the batch gate, before the claim.** Same position and shape as `rate_minute` / `rate_24h`. Checking after the claim would leave rows stuck in `sending`; checking per message would be a query per message on the hot path.
- **SOFT.** `carrier_daily_cap` is deliberately absent from `isHardStop` — rows stay `pending`, nothing latches, and the next tick resumes on its own (immediately if another carrier is free, otherwise after ET midnight). A daily allowance running out is an expected event, not a breaker trip needing a human resume.
- **Surgical.** It only fires for a capped carrier that **still has pending rows on this stage**. Without that condition, an exhausted cap on VoIP would halt a stage whose remaining recipients are all Verizon — and every other stage on that number for the rest of the day.
- **BOUNDED OVERSHOOT — it is a soft ceiling, not an exact one.** Mid-batch accounting is **explicitly not built**: once a batch is claimed it is sent in full without re-counting, so a carrier can exceed its limit by at most `batchSize - 1` (49 at the default 50), and only on the batch that crosses it. Making it exact costs a query per message; that is a decision to take deliberately, never a silent tightening.

**The day boundary is passed as a timestamptz RANGE**, never as a functional expression over `sent_at`. Such a predicate cannot use `stage_sends_phone_carrier_sent_day_idx` (migration 0143) and turns a once-per-batch check into a sequential scan of a 1.4M-row table — paid by every drain in the org, capped or not. The guard asserts the query plan names that index, not merely that some index was used.

**Two lessons from building its proof**, both general:

- **Measure a baseline; never assume a clean slate.** The first version of bar (1) inserted three probe sends and asserted `sent_today === 3`. It read **998** — number #224 had really sent 995 messages to Verizon that day. The counter was right and the assertion was wrong. Every claim is now a **delta** against real traffic, which also makes the bar independent of what time of day it runs.
- **A checker must not read the prose about itself.** The guard forbidding the functional form failed against correct code, because `carrier-policy.ts`'s own comment explains that the boundary is never written that way — and the guard matched that sentence. Strip comments before asserting on source.

## A guard that goes red on correct use is a countdown, not a guard

The recurring failure in this repo is an assertion that describes **the state on the day a migration shipped** — "the table ships EMPTY", "the column is NULL everywhere", "every row has `sends_enabled = true`". Each is true when written and expires the first time an operator uses the feature it covers, which is the entire point of having built it. A suite with a known-red check in it stops being read at all.

`scripts/verify-provider-sends-enabled-migration.ts` was **already red on clean `main`** when this sweep ran: it asserted `opt_out_footer IS NULL` on every provider row, and Q3 had gone live with `tls` carrying `"Reply STOP to quit"`.

The rewrite has three parts, and all three are required:

- **REPORT the live configuration** — print which rows are configured and with what. A run must still show what state it ran against.
- **ASSERT the durable invariant instead.** Not *"nobody has set a footer"* but ***"anything set is sendable"*** — a footer without a STOP keyword does not degrade gracefully, it REFUSES every stage on that account. Not *"`sends_enabled` is true everywhere"* but *"`sends_enabled` is a real boolean everywhere"*, which is what keeps `IS NOT FALSE` and `= true` agreeing across the six enforcement sites. The durable form is usually **stronger** than the one it replaces, because it keeps holding after the feature is used.
- **PROVE IT CAN GO RED, from synthesized state in a rolled-back transaction.** A durable invariant that today's data satisfies by accident is indistinguishable from one that is never evaluated. Inject the offending row, assert the check would catch it, roll back, and re-query to confirm nothing survived.

**Never bend the data back to satisfy a stale assertion.** Retire the assertion and replace it with the invariant.

## Corpus harnesses re-derive from FROZEN inputs only

A harness that rebuilds historical output and compares it byte-for-byte is only as sound as its inputs. Three rules, each learned the expensive way on 2026-08-18:

- **The corpus is what was SENT, not what was materialized.** `stage_sends.rendered_text IS NOT NULL` also matches rows that were built and then **recalled** (`status='rejected'`, `sent_at IS NULL`) or are still `pending` — drafts that never reached a handset. Filter on `sent_at IS NOT NULL`. Measured: 75,125 materialized vs **29,396 actually sent** in the same window, and the gap contained a recalled batch whose stage had since been legitimately re-pointed at a different creative. That produced **77 phantom mismatches** and a hard stop on a bar that was, in fact, clean.
- **A live FK an operator can edit is not a valid comparison source.** `campaign_stages.creative_id` moves; `rendered_text` does not. Where an input has no frozen copy, either exclude the affected rows or decompose the comparison so the *builders'* output is still asserted. The Q3 harness decomposes: a difference confined to the brand+creative line is EXCLUDED as input drift, while a difference in the **link or footer line is never excused** — those are what the builders produce. That keeps footer coverage on every row instead of dropping whole rows whenever a creative was touched.
- **Exclusions are output, never silent.** Print the excluded count and the reason next to the result. A bar that quietly drops rows is indistinguishable from one that had nothing to check.
- **Re-state corpus size on every run.** It is not a constant: this one more than doubled mid-workstream (29,917 → 75,125 materialized) while live sending continued, so any "corpus-proven" claim is true only of the snapshot it ran against.

⚠️ A timestamp pin (`exclude rows whose inputs changed after sent_at`) is the obvious design and **is not available here** — there is no `updated_at` on `creatives`, `campaign_stages`, `brands` or `short_domains`. Check before designing around one.

## A corpus assertion must name the WORLD-STATE it models, and pick its cohort accordingly

**A bar that cannot survive its own feature going live is modeling the past.** Every re-derivation harness compares stored output against output rebuilt by *today's* code. That comparison silently assumes the stored rows were produced by the same code — true only until the feature ships. From then on the corpus holds **two populations**, and one assertion cannot be right about both.

Q3 is the worked example. Bar (B) asserted that a body on a footer-configured account differs from today's build *only by the swapped footer substring* — a correct statement about rows rendered **before** the chain shipped, and a false one about rows rendered **after**, whose stored bytes already carry the resolved footer. The first 997 real `tls` sends turned the bar red **because the feature was working**.

The fix is a cohort split, and it has three rules:

- **Split on an EXTERNAL fact, never on the data being judged.** The boundary is the production go-live instant (`Q3_LIVE_AT` — the prod deployment's `success` status). Inferring it from the bodies ("rows ending with the account footer are the post-chain ones") would sort every row into the branch that passes and leave a bar that cannot fail.
- **Split on the timestamp that names the code which produced the bytes.** `rendered_text` is INSERTed once at **materialization** and only READ at drain, so `stage_sends.created_at` is the render time. `sent_at` is stamped later, at dispatch — a stage materialized before go-live and drained after it carries pre-chain bytes under a post-chain `sent_at`. That population is real and is not small: **667 corpus rows** on the run that established this. The harness counts and prints them every run, so a future "simplification" to `sent_at` is confronted with the number of rows it would misclassify.
- **State every cohort's size on every run, including the empty ones.** An empty cohort proves nothing and must say so rather than reporting a pass; it is never folded into the other cohort's count. Non-vacuity of the bar as a whole is itself a `check()`, so "the corpus proved nothing today" cannot pass unnoticed.

**Each model must be shown to FAIL on the world it does not describe** (fault injections #5/#6). Otherwise the split is decoration and one model is quietly doing both jobs. Synthesize those bodies rather than drawing them from the corpus, so the proof holds when a cohort is empty.

## Cleaning test data from production: delete by ID, never by pattern

A fixture cleanup is a hard delete against live data, so the shape of the query matters more than its brevity.

- **Resolve ids first, then delete by explicit id.** `scripts/cleanup-stage-test-fixtures.ts` hardcodes every id it removes. Deleting by pattern (`offer_id LIKE 'STG-O-%'`) is shorter and re-evaluates at run time against rows nobody reviewed.
- **The near-miss that proves it.** `scripts/test-campaign-stages-api.ts` mints fixture contacts as `+15107<unique><nn>`. A cleanup keyed on `phone_number LIKE '+15107%'` matches **451 real contacts in area code 510 (Oakland)**, **400 of which have genuinely sent messages**. The pattern was indistinguishable from the fixture rule; only checking send history separated them. **Any contact that has ever had a `stage_sends` row is a real person**, whatever its number looks like — assert that before deleting contacts, and never infer "fixture" from a phone prefix alone.
- **Signature-check every id immediately before deleting.** Ids get recycled and rows get renamed, so a list approved yesterday may denote something else today. Re-read each target and abort the whole run on a mismatch.
- **Make it re-runnable.** Check that everything which *still exists* matches, not that everything exists. The first run of this cleanup deleted nine of ten row types and left the contacts behind; a pre-flight demanding the full set then refused to finish its own job. An already-deleted row is success.
- **Dry-run by default**, `--apply` to act.

⚠️ **`ANY(${jsArray})` does not work through Drizzle's `sql` template.** The array is flattened into positional params, so a one-element list arrives as a scalar and postgres-js throws `ERR_INVALID_ARG_TYPE`; a `::int[]` cast does not help because the shape is already wrong. Render the list instead (`IN (${sql.raw(ids.join(","))})`) **with a validator that throws on any value that is not a clean integer or UUID**, and only for hardcoded constants. This repo has already lost a cleanup to that exact failure — the delete threw, the enclosing block swallowed it, and a probe row survived in production while the run reported success.

**The residue check is the point.** It caught this run leaving 10 contacts behind after every delete step had printed a tick. Re-query **every** type after deleting, fail loudly on survivors, and assert that the data which must be untouched still has its expected count.

## Prod-writing test suites must enumerate and clean EVERY entity type they create

A teardown that stops at its first failure leaks silently, because the crash surfaces *after* the assertions have printed their result — which is when nobody is reading.

`scripts/test-campaign-stages-api.ts` did exactly this: one delete ran `where id = undefined` (an id pushed from a response that never carried one), postgres-js threw `UNDEFINED_VALUE`, and because the block had only a `finally` the exception aborted every remaining delete — including the brands at the end. **Three `Stage Test Brand` rows sat in production** as a result, and the run that created them reported its residue check as clean because that check looked at campaigns and stages and never thought to look at brands.

**The rules:**
- **Every cleanup step runs independently** (wrap each in its own try/catch that logs and continues). One failure must not cancel the rest.
- **Validate every id before using it in a predicate.** `Number.isInteger(v) && v > 0` — an `undefined` id is a bug in the suite, not a row to delete.
- **Residue verification enumerates ALL entity types the suite creates, not a sample.** The leak this exists to catch is precisely a type nobody thought to check. Surviving rows are a FAILURE of the run, not a log line.
- Deletes use scalar binds, never `ANY(${jsArray})` — that throws under postgres-js and the delete silently never runs.

## Feature flags
- `lib/feature-flags.ts` `ENTITY_AVAILABILITY` is the single source for "is this entity built?". Flip a new entity's flag to `true` **last**, after schema+API+UI work. Gate cross-entity fetches on `isEntityAvailable()` (no speculative 404s).

## Audience semantics
- Segment audience = manual membership **∪** rule matches (Model C); zero active rules ⇒ manual only (preserve this short-circuit).
- **UNION is *within* a segment; segments AND *across* a campaign (changed 2026-08-17, was UNION).** A campaign's selected include-segments **INTERSECT** — adding a segment can only narrow the audience, never grow it. To OR two audiences, use two `or`-combined rules inside **one** segment. The rule exists in two independent implementations that **must stay in lockstep**: `buildAudienceSourceClause` (INTERSECT chain — feeds `snapshotAudience` and the draft-stage counts) and `previewAudience` (a `segments_matched = <n>` test over per-branch ordinals). If they drift, the preview stops predicting what activation freezes. Guard: [`scripts/test-segment-intersect-and-optout.ts`](../scripts/test-segment-intersect-and-optout.ts).
  - **Why it changed:** a "filter-shaped" segment — one whose only rule is an `is_not`, e.g. `in_use_in_campaign_last_period is_not 1w` — matches nearly the entire org by construction. OR-ing it into a campaign *grew* a 44,480-contact audience to 507,870 instead of trimming it. Because the composition helper is shared with the snapshot, activating would have frozen and sent to the inflated pool, so this was a live-send hazard rather than a display bug.
- **Opt-outs: excluded everywhere on the segment page, kept in the campaign source.** Segment-page reads (header tile, Audience tab list + counts, rules preview, contacts CSV export) go through `excludeOptOutsFromAudience()` so they report the **sendable** audience — the same basis as a campaign's "From segments". The campaign path deliberately keeps opt-outs in its source set so `previewAudience` can report `excluded_for_optout` before `qualifies` strips them, and so the snapshot anti-joins them exactly once against an ANALYZE'd temp table. Don't "unify" these by folding the exclusion into `buildSegmentAudienceClause` — that duplicates an anti-join into every segment branch on the perf-critical activation path.
- Campaign audience is **frozen at activation**; locked afterward (`audience_locked_after_draft`). Both `exclude_in_use_contacts` flags (segment + campaign) only consider `status='active'` campaigns.

## Segment rule set-shaped values — register in all four places (migration 0129)
- **`sent_from_provider_phone`** matches contacts with ≥1 `stage_sends` row where `status='sent'` AND `provider_phone_id` is one of the chosen numbers (`{provider_id, phone_ids[]}`, provider-scoped, `is`/`is_not`, no time window). **`status='sent'` is the single shared definition of "was messaged"** across the platform — the reports rollup ([lib/reporting/rollup.ts](../lib/reporting/rollup.ts)), the send circuit breakers (opt-out-rate, failure-spike), and this rule all key off the same status value, so a contact counted as messaged by one screen is messaged by every screen. Backed by the partial index `stage_sends_org_provider_phone_sent_idx (org_id, provider_phone_id) INCLUDE (contact_id) WHERE status='sent'` — measured **80.9 ms** index-only scan on the selective phone (86,762 rows) vs an **8,480 ms** two-seq-scan baseline for the read-time-`COALESCE` approach that was rejected in design. The org's two dominant numbers each match roughly a third to a half of its contacts (462,569 / 334,150 measured), so a preview scoped to one of them may approach the rules-preview 10s timeout and degrade to `truncated` — a data property, not a defect.
- **A set-shaped rule value (an array or object, not a scalar FK id) must be registered in FOUR places, not two.** `RULE_TYPES` ([lib/validators/segment-rule-types.ts](../lib/validators/segment-rule-types.ts)) and `validateValueByShape` ([lib/validators/segment-rules.ts](../lib/validators/segment-rules.ts)) are the obvious two — get those right and the rule *looks* like it works, because Zod accepts the value on save. But `isRuleComplete` ([lib/segment-rules-eval.ts](../lib/segment-rules-eval.ts)) and `verifyValueOwnership` ([lib/api/segment-rule-value-ownership.ts](../lib/api/segment-rule-value-ownership.ts)) both fall through to a `typeof value === "number"` test by default, and an array/object value fails that test silently. Missing the `verifyValueOwnership` case rejects rule creation outright (400 "Value must be a positive integer"); missing the `isRuleComplete` case would let a malformed value slip past validation and then be silently dropped from evaluation rather than counted or refused. **This is exactly how `phone_type`/`carrier` (migration `0098`) shipped broken** — both were added to `RULE_TYPES` and `validateValueByShape` but never to the other two, so neither could ever be created in production (confirmed: prod had zero rows of either type before this fix). Fixed alongside `sent_from_provider_phone`, which hits the identical code path.

## Carrier / line-type eligibility (migrations 0095–0098 — see [04-features/phone-lookup-carrier.md](04-features/phone-lookup-carrier.md))
- **The landline hard stop is `contacts.messaging_status`** (`eligible` | `not_applicable`), derived by trigger from `line_type` (`landline ⇒ not_applicable`, everything else — incl. `voip`, `toll_free`, `unknown` — ⇒ `eligible`). Never write `messaging_status` directly; the trigger overrides it. Never treat `unknown` as ineligible (conservative default — never silently suppress).
- **Every audience, segment, campaign, stage, and send query adds `AND messaging_status='eligible'`**, matching the eligible-partial indexes. Landlines must be absent from segments, audience counts, previews, stats, send queues, and link minting — **except the Contacts admin screen** (the one place they stay visible, shown as "Landline / Not applicable").
- **`phone_lookups` is a GLOBAL cache** (no `org_id`) keyed on E.164 `+1XXXXXXXXXX`. Normalize to that exact shape (via `lib/phone-validation.ts`) before both the Telnyx call and the cache write, or the join to `contacts.phone_number` silently misses and you double-pay.
- **Carrier buckets** are the six `carrier_norm` values (`AT&T`/`T-Mobile`/`Verizon`/`Other Mobile`/`VoIP`/`Unknown`). Two non-bucket states (migration 0099):
  - **`Unidentified`** — CONTACTS ONLY: **no `phone_lookups` row exists** for the phone (never looked up, no user data). The default for `contacts.carrier_norm`. Invariant: `carrier_norm='Unidentified'` ⇔ no lookup row. `phone_lookups.carrier_norm` may **never** be `Unidentified` (CHECK-enforced, 0095). Contact sync always overwrites `Unidentified` with a real value (`Unknown` at worst) when a lookup row is written.
  - **`Unknown`** — a lookup occurred (any source) but the carrier is undetermined. Groups with `Unmapped`.
  - **`Unmapped`** — looked up, raw string awaiting an admin mapping. Groups with `Unknown`.
- **Campaign carrier filter:** dropdown offers the six buckets (`Unknown` selectable; **`Unidentified` is not**). No filter ⇒ everyone eligible participates incl. `Unidentified`. Any filter set ⇒ `Unidentified` is **always excluded** and reported on its own line ("N removed as unidentified (never looked up)"); selecting `Unknown` matches `IN ('Unknown','Unmapped')`. Enforced in the shared audience builder (send-time), not just preview.
- **Segment carrier rule:** both `Unknown` and `Unidentified` are selectable (`Unknown`→`('Unknown','Unmapped')`, `Unidentified`→itself).
- **Reporting** (Telegram summaries, contacts stats widget, audience preview) counts `Unidentified` and `Unknown` as **separate lines** everywhere.
- **Precedence:** `telnyx` overwrites anything; `csv_import` never overwrites an existing `telnyx` row.
- **Lookups are SCOPED-only — there is no full-database run.** Every lookup targets a bounded subset of existing contacts: an upload, a **contact group** ("Look up this group"), or a **matched list** ("Look up a list of existing numbers", existing contacts only — never creates contacts). The old whole-table "backfill everything" pathway was removed. All entry points enqueue into the one queue and drain under the one worker/cap/lease/balance gate; enqueue dedups against cache-complete + already-pending (never re-pays), and there is no re-look-up path (only-missing). Scoped enqueues use `trigger='upload'` (the `lookup_batches.trigger` CHECK is unchanged). Runs over 25k numbers get a heavier type-to-confirm; the preview always shows count, live balance, and days-to-drain at the cap. Cost estimates are **provisional** — real spend is the batch Est-vs-Billed (ledger) line.
- **Landline cleanup cancels `stage_sends` `status='pending'` only — never `sending`** (mid-flight; deleting can't unsend and breaks the DLR match). The contact still becomes `not_applicable` for everything afterward.

## Content dedup & offer exposure (migration 0086 — see [04-features/content-dedup.md](04-features/content-dedup.md))
- **"Used" = a `stage_sends` row that reached `status='sent'`** — the only per-recipient success marker. External-CSV campaigns (no `stage_sends`) are an accepted blind spot.
- **Hard rule keys on `creatives.id`, never text/slug/hash.** Edits are in-place (same id); a new creative (via `/duplicate`) is the path for re-sending changed content.
- **Dedup is org-scoped and intentionally spans brands.** Contacts (`UNIQUE(org_id, phone_number)`, no `brand_id`) and creatives are brand-agnostic. Never add `brand_id` to the exposure tables.
- **A send's offer is the campaign's `offer_id`, never `creative_offers`.** `creative_offers` is authoring-only; offer attribution is unambiguous via `campaigns.offer_id`.
- **Distinct counts are maintained write-time, read O(1).** `offer_exposure_counts` is trigger-maintained; the offer page reads one row, never `COUNT(DISTINCT …)`.
- **The ledgers are populated by DB triggers on `stage_sends`, not app code** — `status='sent'` is set from multiple paths (drain + poller); a trigger guarantees none bypasses the ledger.
- **Send-time eligibility has ONE shared builder** ([`lib/sends/eligibility.ts`](../lib/sends/eligibility.ts) — `buildStageEligibilityExclusions` / `applyEligibilityExcept` / `eligibilityUnion`), consumed by `stageRecipientsSql` (send kickoff + CSV export + preflight), `reconcile.ts`, and the preview. Never compute eligibility separately in any path. Keyed on the stage's `creative_id` + campaign's `offer_id`; the layer-1 clause `(campaign_id IS NULL OR campaign_id <> currentCampaignId)` is the in-campaign-reuse exception — never flatten it. Null creative ⇒ omit layers 1+2 (Edge A). Layer 3 only when `campaigns.exclude_prior_offer_contacts`.
- **`campaigns.exclude_prior_offer_contacts`** (default false) is set in draft and locked after activation (in the audience-lock set), but its value is read **live** at send time (not baked into the frozen snapshot).
- **`reconcile.ts` partitions `pool = attempted + excluded(opt_out | filter | split | dedup) + gap`** — the `dedup` bucket is essential; without it a deduped campaign shows a false materialization-gap alarm.
- **The stages-list `audience_count` is the pre-dedup addressable pool** (perf-tuned batched query, untouched); the post-dedup will-send number is in the Prepare popup + the stage preview.
- **Behavioral-lane audience counts are deferred + batched, never inline in the stages list.** The lane live-tier scan (`links⋈clicks` + `stage_sends`) is seconds each; a split has 3 lanes, so computing them inline made the stages list take 30–60s. The list returns lanes with `audience_count = null` (rendered `computing…`); the client then hits `GET /api/campaigns/[campaignId]/stages/lane-counts`, which runs `computeLaneAudienceCountsBatch()` — **all** lanes of a campaign in **one** query (tier map = a single `MATERIALIZED` CTE reused per lane; parent "alive" set built once). Proven identical to the old per-lane `countStageRecipients` path by [`scripts/verify-lane-batch.ts`](../scripts/verify-lane-batch.ts). Don't move lane counts back onto the critical path.
- **The offer counter (`offer_exposure_counts`) and the preview breakdown are read-time-cheap** — single-row counter join, single-CTE preview (`computeStageEligibilityPreview`, timeout-guarded). Never `COUNT(DISTINCT …)` at read time; never recompute the preview as four segment resolutions.

## Provider credentials (multi-account + encryption, migration 0110)
- **A credential row IS an account.** `provider_credentials` moved from "one key per (provider, brand)" to N accounts per provider — each row carries an operator-facing `label` (e.g. "Main account", "Backup account") distinguishing them; `brand_id` (NULL = provider-wide default) still scopes a credential to a brand but no longer disambiguates when two accounts share a scope. Both single-account unique indexes are DROPPED (migration 0110: `provider_credentials_provider_brand_uniq`, `provider_credentials_provider_default_uniq`) — a provider can hold any number of credentials.
- **Number → account → key.** `provider_phones.credential_id` (nullable, `ON DELETE SET NULL`) points at the credential a number sends through. `resolveKeyForStage` ([lib/sends/provider-credential.ts](../lib/sends/provider-credential.ts)) resolves `stage.provider_phone_id → provider_phones.credential_id → provider_credentials` first — the only path once a provider has ≥2 accounts.
- **Scoped fallback for numberless stages — never guesses.** A stage with no `provider_phone_id` falls back to the old `(provider, brand)`/default lookup **only while the provider has exactly ONE credential**. The moment a provider gains a 2nd account the fallback returns `null` — a numberless stage on a multi-account provider is a hard `no_credentials` refusal, not a silent guess. `hasResolvableCredential` mirrors this reachability check without ever touching the secret columns (used by kickoff/preflight). **Same rule governs delete:** removing a credential unlinks its numbers (`provider_phones.credential_id` is `ON DELETE SET NULL`) — if that leaves the provider with exactly one surviving credential, sends on those now-numberless phones automatically fall back to (and are billed to) the survivor's key; with zero or several credentials left, they hit the same `no_credentials` refusal until manually relinked.
- **Sequencing guardrail — the 409 that keeps the fallback safe.** `POST /api/providers/[providerId]/credentials` refuses (409 `numberless_stages_block_multi_account`) to create a 2nd+ credential while the provider still has any send-eligible (`draft`/`pending`/`sent`) stage with no `provider_phone_id` OR with a `provider_phone_id` whose `provider_phones.credential_id` is still NULL/unlinked (`lib/providers/second-account-guard.ts`, `countNumberlessSendEligibleStages`). The operator must assign account-linked numbers to every such stage before a provider can go multi-account — this is what keeps the single-credential fallback above from ever becoming ambiguous in practice.
- **Blob format + rotation story.** `lib/crypto/secret-box.ts`: AES-256-GCM, 12-byte random IV per encryption, blob `v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(authTag)>`. The leading version segment is the rotation seam — a future master-key rotation ships new writes as `v2.` while `v1.` blobs keep decrypting under the old key logic, no big-bang re-encrypt required. Master key: env `PROVIDER_CREDENTIALS_KEY`, 32-byte base64, MUST be byte-identical between Vercel and any local `.env.local` that decrypts (dev scripts) or encrypts (the backfill) — a mismatch makes every affected row silently unreadable, not an error at write time.
- **Dual-read window.** `provider_credentials.api_key` (plaintext) is nullable as of migration 0110 and stays populated for existing rows until a later, separately-gated migration `0112` drops it (after `0111` tightens the new columns to `NOT NULL`; neither is applied yet). `decryptCredentialKey` — the one shared dual-read primitive, called by every read site rather than inlining `decryptSecret(...) ?? ...` — prefers `api_key_encrypted`, falls back to plaintext. New/rotated credentials write ONLY the encrypted column (`api_key` set to `NULL` on rotation).
- **Decryption happens in exactly five places**, never in a list/GET response: the send drain (`resolveKeyForStage`), the two opt-out/DLR pollers (`selectPollableCredentials` in `lib/sends/poll-opt-outs.ts`, `pollAhoiCdr` in `lib/sends/ahoi-cdr-poll.ts`), the credential test-send route, and the register-callback route (both via `resolveCredentialKeyById`). `GET .../credentials` never selects for decryption — `api_key_last4` is populated at write time for display.
- **Pollers skip-on-decrypt-failure, never crash.** Both pollers wrap `decryptCredentialKey` in try/catch per row: a malformed blob, wrong version, bad auth tag, or a misconfigured `PROVIDER_CREDENTIALS_KEY` throws — the row is skipped with a `console.warn` (never logs the key or the raw error) and the poll continues for every other credential. Consequence: a wrong or missing master key doesn't crash anything visibly — it silently skips every credential, and opt-out intake stops with only console warnings as the signal. Check the master key first if a poller's processed-count drops to zero.
- **Permission split.** `provider_credentials.view` (manager+) gates the masked list (`GET`) and the admin UI section's visibility; `provider_credentials.manage` (admin+) gates every mutation — POST/PATCH/DELETE, test-send, register-callback — and every mutate button in the UI. Two new permission literals (`lib/permissions.ts`) since no admin-tier providers permission existed before; flipped atomically with the UI.
- **Never returns the plaintext.** Every response (list, create, PATCH, DELETE) is masked (`label`/`last4`/`masked`/`linked_numbers`) — the encrypted blob and the plaintext are both server-only. Test-send and register-callback echo what was *sent* (message text, callback URL), never the key.
- **Backfill (applied 2026-07-16, idempotent).** `scripts/backfill-provider-credentials-encryption.ts` encrypted the 2 existing plaintext rows (TextHub cred 2, Ahoi cred 262) and linked their providers' phones (26/27/43 → cred 2, 44/45 → cred 262), since each provider had exactly one credential at backfill time. Plaintext `api_key` was left populated (dual-read window). A post-write reconciliation step re-queries the DB and asserts the exact expected inventory, aborting rather than silently drifting.
- **The API-key field is the BASELINE for every provider type; login shapes (email+password etc.) are per-provider EXTRAS layered on top, never the baseline** (decision 2026-08-12, ClickUp 869egmakh open decision #2). `ProviderCredentialsSection`'s key input has always been provider-agnostic and write-only — what made it read as single-provider was the *copy*: the Add/Rotate placeholders hardcoded "TextHub" on every provider's page. They now interpolate the provider row's `name`. A new provider therefore needs **no form work at all** to store a key: create the provider, Accounts → Add account, paste. Never seed a key by script; the UI write path is the only one that encrypts.
- **Every provider-specific action button MUST be gated to its provider.** The credentials row renders actions that hit provider-hardcoded routes: **Send test** → TextHub's `sendSms`, **STOP callback** → `registerOptOutCallback` + a `/api/webhooks/texthub/opt-out/<token>` URL, **Check connection** → Text Request's `/dashboards`. Ungated, each offers to perform a TextHub (or TR) operation *using another provider's account key*. Send test and Check connection were gated from the start; **STOP callback was not, and rendered for every provider until 2026-08-12** — an Ahoi/Tells account could have registered a TextHub callback against its own key. When adding a provider-specific action, gate it in the same commit. Text Request's own hook registration (`register-textrequest-hooks`) still has no button — tracked on 869egmakh P2, where a descriptor-driven uniform action row replaces this hand-gating.

## Sending safety
- Drain requires all of: `send_approved` (per stage) + the **two-switch send gate** + `CRON_SECRET`/`campaigns.drain` + provider not `send_paused` + provider `sends_enabled`.
- **Three provider flags, three questions — never collapse them (migration 0138).** `sms_providers` now carries a posture switch alongside the capability gate and the breaker latch:

  | Column | Question | Who sets it | Undo |
  |---|---|---|---|
  | `supports_api_send` | CAPABILITY — can this row send over an API at all? | human, own audited endpoint | flip it back |
  | `sends_enabled` | POSTURE — should it, right now? | human, own audited endpoint | flip it back |
  | `send_paused` | LATCH — did an automated breaker trip? | the system (or manual panic) | conscious human resume |

  Merging posture into the latch would make a breaker trip and an operator decision indistinguishable in the audit trail — the one thing `send_circuit_events` exists to keep apart. Refusals are correspondingly distinct: `provider_sends_disabled` (kickoff + drain, HTTP 409, "turn it back on in Settings → Providers") never says "paused", because nothing tripped and there is nothing to resume.
- **`sends_enabled` is enforced in SIX places, and the list is the point.** Kickoff refusal (before materializing, so a switched-off provider never inserts `stage_sends` rows it cannot dispatch); drain gate + a **per-batch re-read** (`isProviderSendsEnabled`, mirroring `isProviderPaused` — the column is runtime-mutable, so switching a provider off is a TRUE mid-run kill, not a next-tick one); `scheduled.ts` **both** phases; `preflight.ts` as a checklist blocker; `send-state.ts` as a `disabled_providers` list kept separate from `paused_providers`; and `stall-detector.ts`, which is not optional — that detector's job is suppressing alarms for stages held ON PURPOSE (it already carries the campaign pause, provider pause, org switch and org emergency stop), so without the predicate, switching a provider off would fire a stall alert for every stage it owns. The scheduler predicates are `p.sends_enabled IS NOT FALSE`, **not** `= true`: those are LEFT JOINs and a stage with no provider row must stay selectable exactly as before (the kickoff `no_provider` refusal owns that case) — the same NULL-tolerant shape as the `send_paused` line beside them. `isProviderSendsEnabled` fails CLOSED on a missing row while `isProviderPaused` fails OPEN, deliberately: a vanished provider is not evidence of a tripped breaker, but it is certainly not permission to keep sending.
- **`sends_enabled` is a SENDING flag, so STOP intake must ignore it.** It is the operator-facing "switch this account off" control, which makes it the flag most likely to be flipped mid-incident — exactly when inbound STOPs must keep landing, and exactly the shape of the original `supports_api_send` defect. `scripts/test-stop-intake-ungated.ts` flips it alongside the others and asserts every intake selection is unchanged; it also asserts the flip actually took effect (8 of 8 rows) so the comparison can't pass vacuously, and compares post-rollback flag counts against a PRE-transaction snapshot rather than a hardcoded "all true" — once an operator legitimately switches an account off, "all true" would be both a wrong restore and a false failure.
- **CamMan OWNS the opt-out footer — never a provider (compliance invariant, 2026-08-12).** Every message carries opt-out language rendered INTO the body via the stage's `stop_text` — **txr uses the same system-wide `stop_text` default (`Stop to END`) as every other provider; there is no txr-specific footer wording**; **do NOT rely on any provider to append one.** Text Request was mistakenly believed to auto-append it "server-side (Phase 0)" — proven false at go-live: an API `/messages` send's own TR record carried no footer (the footer seen earlier came from the TR *portal* UI or was typed in-body). The kickoff preflight enforces this: `hasOptOutLanguage(body)` (a `\bstop\b` check on the effective rendered body) must pass or the stage is refused `missing_opt_out_language`. **Enforced for `txr` now; other API providers DRY-RUN it** (a `console.warn` + best-effort Telegram per hit, no refusal) through a 30-day observation window (started 2026-08-12) before enforcement widens — review the dry-run hit count then. Segment counting uses the actual rendered body; there is no phantom appended-footer accounting (the old `withProviderFooter`/`TXR_APPENDED_FOOTER` were removed).
- **Two-switch send gate (migration 0063):** the drain needs BOTH `SEND_ENABLED="true"` (env — the deploy-level **backstop**, left permanently on in Vercel; refuses `send_disabled`) AND `org_settings.sends_enabled=true` (DB — the **daily on/off** in Settings → Sending, manager+, audited in `org_setting_events`; refuses `send_disabled_org`). Don't collapse them: the env var is the basement breaker (there only if a UI bug or compromised session flips the DB flag), the DB flag is the operational switch, `send_paused` is the per-provider "something broke" breaker. The DB flag is re-read each batch ⇒ a true mid-run kill; the env var is immutable per invocation.
- `send_paused` is a latching kill-switch — requires a conscious human resume; trips/resumes audited in `send_circuit_events`.
- **Per-phone MPS is a compliance invariant, and pacing alone does NOT enforce it across invocations.** `max_sends_per_second` is paced *inside* one `runStageDrain`, so two concurrent drains on one number simply double the real rate. Phase B therefore leases each phone group: `withKeyedLease(dbc, "send-drain:p<phoneId>", PHASE_B_DEADLINE_MS, …)` ([`lib/cron/keyed-lease.ts`](../lib/cron/keyed-lease.ts)) — one lease per SENDING NUMBER, so overlapping `send-scheduled` invocations serialize on a number while different numbers stay parallel. **Never widen it to a job-wide lease** (that regresses the 2026-07-24 head-of-line fix) and **never drop it when adding concurrency** — any new parallelism must go *through* the per-phone pacer, not around it. It's a `cron_locks` row, not `pg_advisory_lock` (session locks are unsafe on the `:6543` transaction pooler; a txn-scoped one would pin the whole multi-minute drain to one connection). TTL is absolute-expiry so a killed run self-heals within one cron period; a held lease **skips cleanly** (rows stay `pending`, nothing marked missed, no error) and is counted as `phone_lease_skipped`. Unlike `withCronLease`, this one binds the **manual** trigger too — an MPS breach doesn't care who started the drain.
- **Per-campaign opt-out-rate breaker (migration 0119):** a third latch scope on `campaigns.send_paused`, orthogonal to the per-provider one. An inbound STOP that pushes a campaign's **trailing-24h** opt-out rate (`opt_out_attributions ÷ sent`, same window both sides) to ≥`OPTOUT_RATE_SPIKE_THRESHOLD` (10%) **once ≥`OPTOUT_RATE_MIN_SENDS` (200) have been sent** auto-latches it. Gated on **both** the campaign AND the provider latch (ANDed → a campaign pause holds only that campaign, never the provider). Manual-only resume via `POST /api/campaigns/[id]/send-circuit`; audited in `campaign_circuit_events`. Latch runs in the ingestion tx; Telegram alert fires post-commit. The Ahoi DLR reject-breaker now alerts on trip too (was silent). Per-creative scope is future.
- **Per-stage opt-out-rate breaker, per-campaign latch (migration 0119; cohort re-cut 2026-07-26):** a third latch scope on `campaigns.send_paused`, orthogonal to the per-provider one. Gated on **both** the campaign AND the provider latch (ANDed → a campaign pause holds only that campaign, never the provider). Manual-only resume via `POST /api/campaigns/[id]/send-circuit`; audited in `campaign_circuit_events`. Latch runs in the ingestion tx; Telegram alert fires post-commit. The Ahoi DLR reject-breaker now alerts on trip too (was silent). Per-creative scope is future. Three rules that must not be broken:
  - **ALIGNED COHORT — numerator and denominator describe the SAME messages.** Both are bucketed by `stage_sends.sent_at`; the numerator reaches it through `opt_out_attributions.stage_send_id`. Never bucket the numerator by `oa.created_at` (STOP receipt time): STOPs outlive their own send inside a fixed window, so the ratio becomes unbounded and any threshold can be exceeded. That produced four false auto-pauses on 2026-07-25 at a reported 15–37% against true rates of 0.75–2.80%. Attributions with a NULL `stage_send_id` are **excluded**, with **no `stage_id` fallback** — a fallback silently reintroduces receipt-time bucketing for exactly those rows. The share of unjoinable rows is watched hourly instead (`findUnjoinableOptOutAttributions`, alert >5% on ≥20 rows).
  - **The rate is judged PER STAGE; the pause is applied PER CAMPAIGN.** A campaign mixes a blast with small lanes, so a campaign-level average is dominated by the loudest stage. Only the attributed stage is evaluated — never a fan-out over the campaign's stages (a STOP credits exactly one stage; other stages' denominators only grow, which lowers a rate).
  - **Two windows, two queries.** Long (`OPTOUT_RATE_WINDOW_SEC` 86400 @ `OPTOUT_RATE_SPIKE_THRESHOLD` 0.10) plus a short twin (`OPTOUT_RATE_WINDOW_SHORT_SEC` 7200 @ `OPTOUT_RATE_SPIKE_THRESHOLD_SHORT` 0.08), each with its own min-send floor (200). The short window is a strict subset, so both counts come from ONE query per side via `FILTER` — keep the per-STOP query count at 2. Calibrated on the aligned cohort (318 stages ≥200 sends: 24h max 8.41%, 2h max 6.12%), so each threshold sits above the observed maximum. Trip is `rate >= threshold`; when both breach the short one is reported. The audit reason names the stage and window: `optout_rate_spike: 12.4% (62/500) on stage 1713 over 24h`.
- **Stage operational status `blocked` (rose):** a campaign whose send circuit is latched holds every stage it owns, and because the scheduler's pause gate sits UPSTREAM of the `schedule_missed_at` stamp, those stages change no state at all — they used to render as ordinary blue "Prepared" cards. `deriveStageOperationalStatus` takes `campaignSendPaused` and returns `blocked` **after** `scheduleMissedAt` (a genuinely missed window is the louder fact) and **before** `slipHoldAt` (while the campaign is paused, releasing a lane hold changes nothing). Only stages with outstanding work (`pending`/`sending` rows, or scheduled-but-unprepared) are blocked — a stage that finished before the pause is not affected by it, and counting it would inflate the dashboards' held-message totals.
- **Submission evidence + classification (migration 0064):** every send attempt writes an append-only `send_attempts` row (verbatim TextHub body + redacted request — api_key NEVER persisted). Classification rules (`lib/sends/classify-attempt.ts`): an outcome not confidently a success ⇒ `indeterminate`, **never** counted as sent; `indeterminate`/`sending` rows are **never auto-retried** (preserves at-most-once). Buckets map to owners: `mine_transport`=us, `theirs_rejected`=escalate, `indeterminate`=reconcile.
- **`filtered` send status (migration 0065) is LABEL-ONLY.** A TextHub rejection carrying the structured `{"status":"Suppressed"}` envelope is recorded as `stage_sends.status='filtered'` (not `'failed'`), gated strictly on the `status` token via `isSuppressedStatus()` — never the HTTP code or the free-text `response`. It does **not** add the number to `opt_outs` and does **not** exclude it from future campaigns; it is purely a visible classification (violet "Filtered" tile + Messages filter/badge, separate `filtered` count in the drain result + `send_drain` event). Because it leaves the `failed` bucket, suppressions no longer paint a stage red/"needs attention". Auto opt-out capture / pre-send skipping is deliberately deferred.
- **Reconciliation:** `pool = attempted + excluded(opt_out|filter|split|dedup) + gap`; a non-zero `gap` is OUR bug (a materialized recipient went missing) and is surfaced, never hidden in count math.
- **Stage split uses a STABLE per-contact hash bucket, never `row_number()`** (`splitBucketMatch`, [`lib/sends/split-bucket.ts`](../lib/sends/split-bucket.ts)): `((hashtextextended(contact_id::text,0) % splitTotal) + splitTotal) % splitTotal = splitIndex-1`. A bucket depends only on the contact's own id, so windowed/resumable materialization (which excludes already-materialized contacts) can't shift anyone into the sibling's half. A `row_number() % splitTotal` split re-numbered the shrinking remaining set on each resume and **leaked the other stage's half** (incident `8_62_070326_1`: 7,500 sent per half instead of 5,000, 5,000 double-sent). This one helper is the ONLY split definition — the send query, both CSV exports, all audience-count previews, and reconciliation call it, so preview/export/reconcile mirror what sends. Buckets are approximately even, not exactly 50/50.
- **Global 1-hour send-dedup is a HARD gate (migration 0090).** Before dispatching, the drain marks any claimed row whose **phone** already got a `status='sent'` message within `SEND_DEDUP_WINDOW_MS` (1h, [`lib/sends/dedup-window.ts`](../lib/sends/dedup-window.ts)) — org-wide, across every campaign/stage, plus same-batch duplicates — as **`skipped_duplicate`** (terminal: not sent, not opted-out, not auto-retried). A number never receives two messages within the window regardless of upstream bug or intentional rapid drip. Surfaced via a `skippedDuplicate` drain count + Telegram alert + Activity "Skipped (1h)" tile/filter/badge; a fully-skipped stage reads "needs attention", not green. Change the window in one place.
- **Lane children never fire before their parent completes (migration 0117, P4).** A behavioral lane child (`parent_stage_id` set) is gated in the scheduler ([`lib/sends/child-slip.ts`](../lib/sends/child-slip.ts) `decideChildSlip`): it only materializes once the parent is COMPLETE (`sent_at` set AND no `pending`/`sending` rows — `failed`/`skipped_*` are terminal and don't block; the lane aliveness filter already drops a `failed` contact). If the parent overruns, the child is **slipped** to `parent_complete + original_offset` (quiet-hours-aware, rolling to the next ET day via `nextWindowOpenAtOrAfter`), capped at **24h** past the original — beyond which it is **HELD** (`slip_hold_at`, parked for a human), never fired or burned as `schedule_missed_at`. A provider paused mid-drain freezes its stage's `pending` rows → parent never completes → dependent child holds at 24h with a Telegram alert: the intended fail-safe (a direct consequence of the latching per-provider pause — the P8 blast-radius policy call). Slip alerts carry the new fire time; hold alerts are self-sufficient (campaign, stage, original time, reason, action).
- **Preflight before materialize + Autopilot week view (migration 0118, P5/P6).** A `*/5` cron ([`lib/sends/send-preflight.ts`](../lib/sends/send-preflight.ts)) computes each scheduled stage's resolved-audience breakdown ~15 min before it materializes and posts a Telegram digest + red alerts (post-once via `preflight_notified_at`); the breakdown ([`preflight-breakdown.ts`](../lib/sends/preflight-breakdown.ts)) predicts the **1-hour phone dedup** (`dedup_1h_predicted`) so a stage that will be ~100% `skipped_duplicate` is visible BEFORE it fires. `/sends/autopilot` renders the week with slip state + parent-gate + preflight, a new **`held`** operational status for slip-held children, and **release-hold** / **preflight-abort** actions. `preflight_aborted_at` holds a stage out of Phase A (mirrors `slip_hold_at`). Release-hold preserves `slip_original_scheduled_at` for audit unless the operator supplies an explicit new time.
- **Send-time opt-out invariant is a HARD gate (migration 0116).** Opt-outs are filtered into the frozen `stage_sends` set only at materialization, so a pre-built/scheduled stage could otherwise text someone who STOPped between build and dispatch. Before sending each claimed batch the drain re-checks `opt_outs` (right before the 1-hour dedup gate) and marks opted-out rows **`skipped_opted_out`** (`last_error='opt_out_cancel'`, terminal, never sent); the opt-out ingesters ([`poll-opt-outs.ts`](../lib/sends/poll-opt-outs.ts), [`ahoi-optout.ts`](../lib/sends/ahoi-optout.ts)) also cascade-cancel still-`pending` rows for the contact on intake. A **distinct** bucket from `filtered`/`failed`/`rejected` so STOP-cancels stay separately countable. Applies identically to scheduled and manual sends (shared `runStageDrain`).
- **One opt-out → the latest stage only.** An inbound STOP is credited to **exactly one** stage — the most-recent `status='sent'` message to that number inside the 72h window (`latestSendForAttribution`, tie-break: higher `stage_id`, then higher `stage_send_id`) — so a multi-message sequence never counts a single opt-out more than once. This keeps `/reports` "Avg Opt-out" the true per-message rate. The org-wide `opt_outs` suppression row is independent and always written. (Before 2026-06-24 the poller fanned one row out to every stage in the window; collapse legacy data with [`scripts/backfill-optout-latest-stage.ts`](../scripts/backfill-optout-latest-stage.ts).)
- **Copy rule:** the system says **"Submitted" / "Accepted by TextHub", never "Delivered."** There is no DLR — the strongest claim is that TextHub accepted the message.
- **Sending number is mandatory for every API-send (tracked) stage (2026-07-22).** TextHub's `sender` parameter and Ahoi's `source` both resolve from the same stage field, `campaign_stages.provider_phone_id` — TextHub via `toTexthubSender()` ([lib/sends/texthub.ts](../lib/sends/texthub.ts)), Ahoi via `toAhoiRecipient()`. Both render the number as **national digits, no country code** (10 digits for 10DLC/TFN, 5–6 digit short codes as-is; US-only assumption, hand-rolled — no `libphonenumber`, which throws under `tsx`). Any tracked stage on a `supports_api_send` provider (TextHub `txh`/`txh2`, Ahoi `ahi`) with no `provider_phone_id` is refused at kickoff (`no_sender_number` — generalized from an Ahoi-only check to cover TextHub too) and flagged in the read-only preflight checklist ("Sending number assigned"); the TextHub adapter also refuses cleanly on a null sender as a last-line backstop, mirroring Ahoi — **never** a silent fallback to TextHub's account-default sender. A pre-deploy audit ([scripts/audit-stages-missing-sender.ts](../scripts/audit-stages-missing-sender.ts)) lists any currently-active stage the new gate would strand. **`campaigns.default_provider_phone_id`** (migration 0115) is a **prefill-only** convenience — it pre-fills a *new* stage's provider+phone, never a send-time fallback; see [04-features/campaigns-stages-creatives.md](04-features/campaigns-stages-creatives.md) and [04-features/sms-send-pipeline.md](04-features/sms-send-pipeline.md).
- **Segment ceiling (G8, Ahoi Phase 1 Section 2).** `MAX_SEGMENTS = 4` in `lib/sends/segments.ts` is a hard ceiling enforced at kickoff preflight (`lib/sends/kickoff.ts`) — text rendering to more segments than this is refused (`segment_ceiling_exceeded`) regardless of the creative's `allow_multi_segment` override. Default policy is single-segment-only (`creatives.allow_multi_segment = false`); the override permits 2–`MAX_SEGMENTS` segments, never unlimited. `countSegments()` wraps the existing `calculateSmsSegments` (`lib/creative-helpers.ts`) — do not fork a second GSM-7/UCS-2 implementation.
- `SEND_ENABLED` stays ON in production as the backstop; `org_settings.sends_enabled` defaults OFF and gates day-to-day. Live sending has not fired.
- **`campaign_stages.sent_at` is the scheduler fire-lock** — the `send-scheduled` cron only considers stages with `sent_at IS NULL`. Only the pipeline (scheduler / manual drain backfill) may write it on a tracked campaign. Marking a **tracked** stage `'sent'` via the manual status action is blocked (409) so bookkeeping can't silently cancel a scheduled send.
- **`sent_at` is stamped IF AND ONLY IF a drain actually attempted ≥1 send (`processed > 0`)** (Bug 1). Neither scheduler Phase A (materialize) nor any gate-refused drain (env `SEND_ENABLED` off, DB `sends_enabled` off, `send_paused`, window closed) may stamp it — a refused stage stays armed and re-selectable, never a false "Sent". Re-materialization is prevented by the rows existing, not by `sent_at`.
- **Stage tracking-link param is the fixed `sub_id3`** (`STAGE_TRACKING_PARAM`, [lib/stage-url.ts](../lib/stage-url.ts)) — the key Keitaro ingests for attribution, the same for every offer; NOT the per-offer `postfix` (operators set those to page slugs). The send mint prefers the stage's stored **`full_url`** (operator's source of truth), but trusts it only when it carries the stage tracking id in a **well-formed** way — a malformed guidekn URL (or one lacking the tracking id) falls back to the canonical server rebuild, and a resolved destination that is still malformed is refused (`invalid_destination`). The old `includes(trackingId)` trust check was fooled by the id-glued-into-the-path defect.
- **Guidekn destination shape is enforced at four layers.** Canonical form: `https://www.guidekn.com/lp/<slug>?sub_id3=<tracking_id>` (one param; slug is lowercase alphanumeric `[a-z0-9]+`, e.g. `orv`, `gb1`). The concat-defect guard keys off an underscore in the `/lp/` path segment (tracking ids always carry them), so digit-bearing slugs like `gb1` are no longer mistaken for id-in-path (migration 0111 widened the DB CHECK to match). `validateDestination(url, trackingId?)` in [lib/stage-url.ts](../lib/stage-url.ts) is the single source of truth, wired into the stage form (blocks Save, names the defect), the write routes (4xx on `full_url`), the send path (rebuild-or-refuse), and DB CHECK `link_destinations_guidekn_url_shape` (migration 0094, `NOT VALID` — enforces new writes; one legacy row `stage_id=516`, tracking_id `8_62_061226_3_s6_c124`, deliberately left un-repaired pending review, so the constraint isn't `VALIDATE`d yet). Non-guidekn URLs (network links) and empty/auto URLs are out of scope and pass. The tracking-ID chip attaches a proper `sub_id3=<id>` param (never a bare value). Legacy repair: [scripts/backfill-guidekn-destinations.ts](../scripts/backfill-guidekn-destinations.ts). See [04-features/tracking-attribution.md §5b](04-features/tracking-attribution.md).
- **Scheduled sends are batched + resumable.** Kickoff mints links in bulk (never per-recipient — that blew the 300s cron limit at ~178s/1000), and the drain resumes across `*/15` ticks (phase B drains `pending` rows in budget-bounded batches). Large audiences send over multiple ticks, paced by the provider's `max_sends_per_run` / `max_sends_per_minute`.
- **A stage can't be scheduled in the past.** Stage create (`POST`) and edit (`PATCH`) reject a `scheduled_at` earlier than now (60s grace for minute-granularity input) with a `validation` error on `scheduled_at`; PATCH only enforces it when the value actually changes, so an unrelated edit to a stage with a historical schedule still saves. The shared guard is [`lib/sends/schedule-guard.ts`](../lib/sends/schedule-guard.ts) (`isScheduledAtInPast`), mirrored client-side in the stage form (inline error + blocked save).
- **A copied/duplicated stage NEVER inherits the parent's send date or `sub_id3`.** All four copy paths — manual stage duplicate ([.../stages/[stageId]/duplicate](../app/api/campaigns/[campaignId]/stages/[stageId]/duplicate/route.ts)), behavioral lane split ([lib/stages/behavioral-split.ts](../lib/stages/behavioral-split.ts)), A/B split ([.../stages/[stageId]/split](../app/api/campaigns/[campaignId]/stages/[stageId]/split/route.ts)), and campaign duplicate with `include_stages` ([.../campaigns/[campaignId]/duplicate](../app/api/campaigns/[campaignId]/duplicate/route.ts)) — set the new stage's `scheduled_at = null` (a stale past date would auto-fire on approval) and give the new stage its own `sub_id3`. **The two split paths (A/B + behavioral) rebuild the sibling/lane `full_url` CANONICALLY** from its own tracking id (`buildStageFullUrl` → `…/lp/<slug>?sub_id3=<newId>`) for guidekn/empty sources, so a malformed source base can't propagate; custom non-guidekn URLs are preserved via `setUrlParam`. **The two duplicate paths** still `setUrlParam(url, STAGE_TRACKING_PARAM, newTrackingId)` — surgical, correct for any well-formed source (the post-fix invariant), preserving `sub_id1` and every other param. All run in the same post-insert step that assigns the new tracking id. No URL ⇒ no-op. Split dialogs preview each variant/lane's tracking id live (parity with a regular stage's on-the-go preview).
- **A stage with no send/result data can be hard-deleted; a stage with any can't.** `DELETE /api/campaigns/[campaignId]/stages/[stageId]` (`stages.delete`, manager+; [lib/stages/delete-stage.ts](../lib/stages/delete-stage.ts)) checks `sent_at IS NULL` AND no rows in `stage_sends`/`stage_results_imports`/`stage_manual_sales`/`keitaro_stage_results` before deleting — existing FK cascades clean up the child rows (`links`, behavioral lanes, opt-out attributions, …), `campaign_events` keep the history with `stage_id` SET NULL. A sent/result-bearing stage gets a 409 (`stage_has_send_data`) and must be archived instead. Deleting the extra members of an A/B split reverts the lone remaining member to a normal stage (`resetLoneSplitSurvivor` in [lib/stages/split-membership.ts](../lib/stages/split-membership.ts)). Both re-split guards (A/B `/split` and behavioral `performBehavioralSplit`) count only **live** (non-archived) partners/lanes, so archiving OR deleting the other variants of either split kind unblocks re-splitting the original — see [04-features/campaigns-stages-creatives.md](04-features/campaigns-stages-creatives.md#deleting-stages).
- **A null send date is never "send now" — `no_schedule` guard.** `kickoffStageSend` refuses any stage with a NULL `scheduled_at` (`reason: "no_schedule"`), the shared chokepoint for the cron, the manual kickoff route, and Approve-Send. The cron's `selectDueScheduledStages` already filters `scheduled_at IS NOT NULL`; the manual Approve-Send path no longer treats null as immediate. To send immediately, the explicit **Send now** action (`send_now: true`) stamps `scheduled_at = now()` **before** kickoff so it passes the guard — immediate sends are never routed through a null date. This is the real enforcement behind "a copied stage can't be enabled for sending until a date is set"; a blank UI field alone is not enough.
- **Emergency hard-stop on Today's sends.** `org_settings.sends_paused` (migration 0080) is a one-click org-wide pause flipped from the Today's sends screen, independent of the daily `sends_enabled` switch. The drain re-reads it every batch, so engaging it halts any in-flight send at the next batch boundary and refuses new ones — no further message is submitted via the provider API until "Proceed" clears it. See [04-features/sms-send-pipeline.md](04-features/sms-send-pipeline.md).
- **WS4 terminology is locked:** the action is **"Prepare"** (approve + materialize + mint links → `stage_sends` rows), the resulting state is **"Prepared"**. Never "Arm"/"Armed". The Prepare confirm popup is ONE shared component ([stage-prepare-dialog.tsx](../components/campaigns/stage-prepare-dialog.tsx)) used by every entry point (list row + editor) — never duplicate it.
- **Operational status is derived, not the `status` column.** [lib/stages/stage-status.ts](../lib/stages/stage-status.ts) is the single source for the five-state "will it send?" model (draft / scheduled_unprepared / prepared / sending_sent / missed_failed). The **Orange↔Blue split is materialization** (`stage_sends` rows exist), NOT whether `scheduled_at` is set — a scheduled stage with no rows is Orange ("won't send until you Prepare it"). It applies to `link_mode='tracked'` only (returns `null` otherwise → manual-status color). Don't hardcode these colors/labels elsewhere; the row renderer, legend, and fleet dashboard all import the map. See [04-features/daily-volume-ui.md](04-features/daily-volume-ui.md).
- **Ahoi DLR reconcile naming debt (Section 3).** `stage_sends.texthub_message_id` is named after TextHub but also stores Ahoi's send-time uuid (Section 2) and is what `lib/sends/ahoi-dlr.ts`'s `reconcileAhoiDlrEvent` matches DLR `provider_uuid` against. Not renamed (G2 — a cross-provider rename is out of scope); every touch point carries a comment.
- **Ahoi DLR defensive classification (G4).** Only `carrier_sent`/`delivered` `send_status` values are confirmed live (Phase 0 recon). `rejected` is handled defensively (feeds the reject-rate breaker, thresholds env-tunable via `AHOI_DLR_REJECT_SPIKE_THRESHOLD` / `AHOI_DLR_REJECT_SPIKE_WINDOW_SEC`) but was never observed live; any other value logs a distinct `console.warn` in `reconcileAhoiDlrEvent` rather than being silently ignored or misclassified. **Section 4 adds a second, narrower defensive layer**: `classifyAhoiDlrOptOut` (`lib/sends/ahoi-dlr-optout.ts`) ships with an EMPTY `AHOI_KNOWN_OPTOUT_DLR_CODES` allowlist — no confirmed Ahoi opt-out-error signature exists (O1) — so `processAhoiDlrOptOut` never writes an `opt_outs` row off a DLR today, but logs every `rejected` DLR's `error`/`smpp_code` distinctly (`[ahoi-dlr-optout]`) so the real code can be added once observed.
- **Two send breakers, one latch (Section 3).** The drain's send-time failure-spike breaker (consecutive send failures, reads `send_attempts`/in-memory) and the DLR reject-rate breaker (reads `ahoi_dlr_events`) both latch the single `sms_providers.send_paused`. They read disjoint tables, so the same failure is never double-counted; `latchPause` is idempotent, so whichever trips first wins and the other composes without re-latching or overwriting the reason.
- **Ahoi cross-channel opt-out dedup (Section 4, CARRY 1).** The inbound webhook (real-time) and the CDR poll (`*/15`) can both capture the SAME physical STOP as two separate `ahoi_inbound_events` rows with no shared identity (webhook rows have no `provider_uuid`). `findDuplicateAhoiInbound` (`lib/sends/ahoi-optout.ts`) dedupes on `(org_id, source_number, normalized_message, time window)` — `AHOI_OPTOUT_DEDUP_WINDOW_MINUTES = 45` (survives one missed CDR poll tick) — against already-`result='suppressed'` rows, so a repeat only ever writes ONE `opt_outs` row and credits ONE `opt_out_attributions` row for the same physical event. The message is normalized (`normalizeAhoiMessageForDedup` — strips the CDR's trailing ` - <n>[ of <m>]` segment marker + commas, collapses whitespace, lowercases) because the two channels represent the same text differently (webhook `"Stop"` vs CDR `"Stop - 1"`), so a raw `message = message` equality would defeat the dedup. A caught duplicate emits a `console.warn` (observable, expected/benign — not a Telegram alert). Not a DB constraint (no natural shared key exists) and not a `pg_advisory_xact_lock` (unsafe under this project's transaction-pooler connection — see `lib/cron/lease.ts`); the residual race is accepted as rare and harmless.
- **Ahoi 10-digit ↔ E.164 (Section 4, CARRY 2).** `ahoiSourceToE164()` (`lib/sends/providers/ahoi.ts`) is the inverse of `toAhoiRecipient()` and the single normalization entry point for Ahoi's wire-format `source`/`destination` fields (10-digit, no `+1`) on both the contact-match and contact-upsert paths — self-contained (NOT via `validatePhone`/libphonenumber, which throws under `tsx`); an Ahoi inbound source is already a real number, so a lightweight NANP-shape check is sufficient.
- **Provider adapter registry keys are the REAL DB `sms_provider_id` values, not descriptive names.** `ADAPTERS` (`lib/sends/providers/registry.ts`) is keyed `"txh"` / `"ahi"` — the short codes actually stored in `sms_providers.sms_provider_id` — because the drain resolves `getAdapter(stage.provider_key)` with that DB column value (`resolveSenderForStage` in `lib/sends/drain.ts`). The registry was originally keyed `"texthub"`/`"ahoi"` (the descriptive provider names), which never matched any real row and would have made `getAdapter('txh')` throw `UnknownProviderError` → `unknown_provider` refusal on every real TextHub drain on deploy (341 stages). `verify-drain.ts` never caught it because it injects a fake `Sender`, which short-circuits before `getAdapter` is ever called (G2) — the regression only shows up on the real resolution path. `scripts/test-provider-registry-db-keys.ts` is the regression test: it asserts every `supports_api_send=true` provider row's real `sms_provider_id` resolves through `getAdapter`, and separately calls `resolveSenderForStage("txh"|"ahi")` with **no** injected sender to exercise the real path. **Issue 2 reconciliation (2026-07-15, follow-up to the re-key above) is now closed:** the duplicate `sms_provider_id='ahoi'` row (id 332, a leftover pre-re-key seed row — see migration `0107`) has been removed from the DB, and every code-level provider-key comparison/query that still read the literal `'ahoi'` — `lib/sends/ahoi-webhook-shared.ts`'s `resolveAhoiCredential` join, `lib/sends/ahoi-cdr-poll.ts`'s `WHERE sms_provider_id = 'ahoi'`, `lib/sends/kickoff.ts`'s no-sender-number guard (`provider_key === 'ahoi'`), and the Ahoi seed/test scripts that queried the row by that key — has been re-pointed to the canonical `'ahi'` key (id 314). The registry itself already used `'ahi'` (that was the original re-key fix); only these trailing comparisons against the now-removed duplicate needed the follow-up.
- **`txh2` = a second TextHub account modeled as its own provider row.** "Texthub - 621637" (`sms_providers.id=499`, `sms_provider_id='txh2'`, created 2026-07-17) is a distinct provider row rather than a second credential on `txh`. It talks to the same TextHub API, so `ADAPTERS['txh2']` reuses `texthubAdapter` (only the resolved per-credential api_key differs); `test-provider-registry-db-keys.ts` covers it. This was a deliberate operator choice (phone `621637` moved off `txh` onto `txh2` + its own account); the multi-account-credentials design would otherwise keep one TextHub provider with two accounts, so treat `txh2` as an intentional exception, not a pattern to copy.
- **`txr` = Text Request (Phases 1–4 built 2026-07-24/25; `supports_api_send=false` until a gated go-live).** Registered `ADAPTERS['txr'] = textrequestAdapter` ([lib/sends/providers/textrequest.ts](../lib/sends/providers/textrequest.ts)); the key MUST equal the real `sms_providers.sms_provider_id` (`'txr'`, id 641) — same rule as every other adapter (a wrong key throws `UnknownProviderError` on the real drain path, which `verify-drain` can't catch). Auth is an `x-api-key` header (TextHub uses a URL query param, Ahoi a `key` form param, SimpleTexting a Bearer token) — the difference lives entirely in the adapter; credential storage is identical. The adapter contract gained an additive optional `NormalizedSendParams.statusCallbackUrl` (TextHub/Ahoi ignore it) and `SendSmsResult.segmentsCount` (persisted to `send_attempts.segments_count`). Classification keys off BOTH the HTTP status and the body `status` (TR uses real status codes, unlike Ahoi's always-200). What each phase added:
  - **Phase 2 — send.** `POST /messages` with `{from,to,body,status_callback?}`; success = 2xx + `status != "error"` + a `message_id`. `toTextrequestRecipient` normalizes to TR's 11-digit `1XXXXXXXXXX`; `textrequestPhoneToE164` is the inverse (the single "TR wire → `contacts.phone_number`" entry point, mirroring `ahoiSourceToE164`). Opt-out codes (2100/30050) map to `suppressed` ⇒ recorded `filtered`, like TextHub's Suppressed.
  - **Phase 3a — real-time DLR.** Per-message `status_callback` → `textrequest_dlr_events`, reconciled DIRECTLY via the URL's `?ss=<stage_send_id>` (falling back to `message_id` → `stage_sends.texthub_message_id`). Like Ahoi's DLR path, reconcile stamps the event row and does NOT mutate `stage_sends` delivery state.
  - **Phase 3b — backstops.** `/api/cron/textrequest-poll` (`4,19,34,49`) runs the messages poll (DLR + inbound STOP backstop), the contacts poll, and the webhook health check. Poll targets are resolved from `provider_phones` bound to a txr credential AND carrying a `dashboard_id` — deliberately NOT "every dashboard on the account", so the poll can never ingest a third party's traffic. A disconnected hook is reactivated via `PUT`; a hook whose `target_url` isn't ours is never touched, and `is_connected: null` (field absent) is NOT treated as broken.
  - **Phase 4 — opt-out intake (compliance-critical).** `processTextrequestOptOut` ([lib/sends/textrequest-optout.ts](../lib/sends/textrequest-optout.ts)) is a deliberate mirror of `processAhoiInboundOptOut`: contact upsert → `opt_outs` → cascade-cancel pending `stage_sends` to `skipped_opted_out`/`opt_out_cancel` → attribution via the shared `latestSendForAttribution` → stage counters + `recomputeStageTotalCost` → `checkOptOutRateBreaker` (Telegram fires post-commit in the caller). Six capture channels feed it, split into two SHAPES — and the distinction is the load-bearing part: **message-shaped** (`webhook_msg_received`, `poll_messages`) must clear the `isOptOutKeyword` gate; **state-shaped** (`webhook_contact_updated`, `poll_contacts`, `dlr`, `send_reject`) skip the keyword gate (TR has already asserted the fact) but act **exactly once per number** — if the number is already suppressed they stop at `already_opted_out`. Without that rule, `has_opted_out=true` would return the same contact on every tick forever and keep re-attributing a months-old opt-out to whatever send happened to be recent. `is_blocked` is NOT an opt-out (TR's abuse control, not consent); `is_suppressed` IS (an operator's "do not text" is as binding as a carrier STOP).

## UI
- `<FormDialog>` for input dialogs (blocks accidental dismissal); `<AlertDialog>` for confirmations; bare `<Dialog>` read-only.
- Required fields → red asterisk via `<FormLabel required>`; no "(optional)" text.
- `<FileDropZone>` for all file pickers; `<MultiSelectPicker>` for >10-option **multi**-selection; `<SearchableSelect>` for >10-option **single**-selection; `<CopyableId>` for system ids.
- **Long single-select lists get a type-to-search dropdown, not a plain `<Select>`.** `<SearchableSelect>` ([components/searchable-select.tsx](../components/searchable-select.tsx)) is the single-select sibling of `<MultiSelectPicker>` — same Radix Popover + filter-input shape, commits one value and closes on pick, with ↑/↓/Enter keyboard nav. Its trigger deliberately mirrors `<SelectTrigger>`'s styling so swapping one in doesn't shift the surrounding layout. Rule of thumb: **≤10 options stay a plain `<Select>`** (operator, AND/OR, lookback period); more than that, make it searchable.

### Browser tab titles (page metadata)
Every route sets its own `<title>`. The root layout ([app/layout.tsx](../app/layout.tsx)) owns the shape:

```ts
title: { template: "%s - Camman", default: "Camman" }
```

so a segment exports only its own bare name (`"Campaigns"`) and the suffix is appended. `default` is the fallback for any route that sets nothing. The two strings live in [lib/page-title.ts](../lib/page-title.ts) — change the brand there, not in 35 files.

⚠️ **A plain-string `title` nulls the inherited template for every segment below it.** A layout that titles itself with `title: "Campaigns"` leaves `/campaigns/[id]` rendering a bare `Campaign` with no ` - Camman`. So any segment that has **titled descendants** must re-declare the template, via the `sectionTitle()` helper:

```ts
export const metadata: Metadata = { title: sectionTitle("Campaigns") };
// → { default: "Campaigns", template: "%s - Camman" }
```

The template is applied to `default` as well, so pass the bare name — baking the suffix in yields `Segments - Camman - Camman`. Six segments need this today (`campaigns`, `campaigns/[id]`, `segments`, `contact-groups`, `providers`, `offers`); every other segment is a leaf and a plain string is enough. A **page**'s metadata never cascades, only a **layout**'s — which is why `reports/page.tsx` can hold a plain `"Overview"` while `reports/[dimension]` still gets the suffix. **When you add a page under an already-titled segment, switch that segment's layout to `sectionTitle()`.**

How a segment sets its title depends on what the page is:
- **Server page** → `export const metadata: Metadata = { title: "…" }` in `page.tsx`.
- **Client page** (`"use client"`) → metadata **cannot** be exported from a client module. Add a sibling `layout.tsx` in that segment that exports `metadata` and returns `children` unchanged. **Do not convert a client page to a server component just to give it a title.** 29 of the 36 pages use this pattern; copy any of them (e.g. [app/(protected)/brands/layout.tsx](<../app/(protected)/brands/layout.tsx>)).
- **Dynamic segment** → `generateMetadata({ params })`, and `params` is a **Promise** (Next 15+) — `await` it. [reports/[dimension]](<../app/(protected)/reports/[dimension]/page.tsx>) needs no I/O at all — it reads the pure constant `DIMENSION_TAB_LABEL`.

Titles track the sidebar labels in [components/protected/nav-config.ts](../components/protected/nav-config.ts) and each page's `<h1>`, so the tab matches what's on screen. `app/page.tsx` sets no title — it always `redirect()`s and never paints.

#### Entity detail pages show the record's name

The five entity detail routes put the real name in the tab — `Summer Promo - Camman`, not `Campaign - Camman`:

| Route | Title | Fallback |
|---|---|---|
| `/campaigns/[id]` | `campaigns.name` | `Campaign` |
| `/campaigns/[id]/edit` | `Edit <campaigns.name>` | `Edit Campaign` |
| `/segments/[id]` | `segments.name` | `Segment` |
| `/contact-groups/[id]` | `contact_groups.name` | `Contact Group` |
| `/providers/[id]` | `sms_providers.name` | `SMS Provider` |
| `/offers/[id]/report` | `offers.name` | `Offer Report` |

Every one of them goes through `entityTitle()` in [lib/entity-title.ts](../lib/entity-title.ts) → `getEntityName()` in [lib/entity-name.ts](../lib/entity-name.ts). Rules that must hold:

- 🔒 **The lookup is org-scoped: `WHERE id = ? AND org_id = <caller's org>`.** This is load-bearing, not defence-in-depth — without the `org_id` predicate anyone could read another tenant's entity name out of their own browser tab by guessing a sequential id. There is exactly **one** function with this SQL so there's no per-route query to get wrong; do not inline a second one. [scripts/test-entity-title-tenancy.ts](../scripts/test-entity-title-tenancy.ts) asserts both directions (owning org → name, non-owning org → null) for all five entities and is read-only. `getEntityName` deliberately imports no auth/Next code so that test can run under `tsx`.
- **One indexed single-row select of the name column.** No joins, no aggregates. `id` is the PK on all five tables, so no extra index is needed.
- **`generateMetadata` must never throw or redirect.** `entityTitle()` uses `getUser()`/`getOrgMembership()` — *not* `requireOrgMembership()`, which calls `redirect()`. Malformed id, missing row, blank name, no session, or wrong org all return the static fallback. (`campaigns.name` is **nullable** — a row existing is not a guarantee of a usable title.)
- **Resolving the org costs nothing extra**: both auth helpers are already `React.cache`'d and already called by the protected layout on every request.
- **A parent layout's `generateMetadata` runs on descendant routes too**, even when the child overrides the title — verified, not assumed. So `campaigns/[id]`'s lookup also fires on `/campaigns/[id]/edit`; `/edit` therefore uses the name as well (`Edit Summer Promo`) so the query isn't wasted, and because `getEntityName` is `React.cache`'d the two `generateMetadata` calls share **one** query. Measured with `pg_stat_statements`: +1 per detail route, +1 on `/edit`, **+0** on `/dashboard`, `/campaigns`, `/segments`, `/contacts`, `/reports`.
- Renaming an entity in-page does **not** update the tab until reload. That's accepted — no client-side title syncing.

[scripts/test-entity-title-render.ts](../scripts/test-entity-title-render.ts) checks the *rendered* `<title>` against a running app as the signed-in `TEST_USER_EMAIL`, plus the fallbacks and the query counts. Source review alone is not sufficient here — that is how the template-nulling bug above reached production.

---

## ⚠️ Doc ↔ code discrepancies (resolve these)

| # | Claim | Reality (code) | Where |
|---|-------|----------------|-------|
| 1 | CLAUDE.md §10b: `draft → active` gates on "name + brand + offer + **≥1 segment**" | Code gates on name + brand + offer + **≥1 contact group**; **segments are optional** | `app/api/campaigns/[campaignId]/status/route.ts` ~L118–135 |
| 2 | ~~`db/schema.ts` `segment_rules_rule_type_check` CHECK list omits `is_in_contact_group`~~ **RESOLVED (migration `0069`)** | `0069` restated the full IN-list (adding the `made_purchase_*` types) and updated `db/schema.ts` + the snapshot to match the live constraint, including `is_in_contact_group` | `lib/segment-rules-eval.ts`, `db/migrations/0069`, `db/schema.ts` |
| 3 | `.env.example` shows `DATABASE_URL` port `5432` / "Session Pooler" | CLAUDE.md §6 mandates **transaction pooler 6543** for serverless; `.env.example` comment is stale on this point | `.env.example`, CLAUDE.md §6 |
| 4 | Original wishlist mentions a command palette | **No command palette / cmdk exists** in the codebase (confirmed absent 2026-06-05) | grep across `components/`, `app/` |
| 5 | `proxy.ts` protected-prefix list (`/dashboard`,`/brands`,`/settings`) | Narrower than the full protected route set; the real gate is `requireOrgMembership()` in the protected layout | `proxy.ts`, `app/(protected)/layout.tsx` |

## Campaign activity log (`campaign_events`)
- Append-only audit of campaign/stage actions, written by `logCampaignEvent()` ([lib/campaign-events.ts](../lib/campaign-events.ts)) at each mutation point and shown in the campaign **Activity** tab. See [04-features/campaign-activity-log.md](04-features/campaign-activity-log.md).
- `event_type` is **free-text, not CHECK-constrained** — the allowed set is the `CampaignEventType` union in code, so new kinds need no migration. Don't add a CHECK.
- Logging is **best-effort** (the helper swallows its own errors) so an audit write can't break the user action. Inside a transaction it must be the **last** statement and is trusted — a thrown error there aborts the whole tx regardless of the catch (Postgres aborts on any error). Outside a tx, the swallow makes it truly non-fatal.
- `actor_user_id` NULL ⇒ system/cron (e.g. the scheduled drain); the UI renders "System / automatic".
- The Activity **Messages** drill-down reads `stage_sends` live — individual recipient sends are **never** copied into `campaign_events`.

## Offer group report (migrations 0093–0133, see [04-features/offer-group-report.md](04-features/offer-group-report.md))
- **Sales are `GREATEST(Σ keitaro_stage_results.sales, Σ stage_manual_sales.delta)` per STAGE, then summed across stages — never simply summed with Keitaro's count.** Same `max`-not-sum convention as the Money section's `combineSales` above, restated here because this report computes it directly in SQL (`offer_report_campaign_econ`'s `stage_sales` CTE), not via `lib/reporting/attribution.ts`. This still governs the **offer total and org benchmark** rows; group rows (below) use a different, per-recipient basis.
- **Sends are `campaigns.link_mode`-based on the offer total and org benchmark rows, not a single column** — `link_mode='tracked'` → `count(*)` of `stage_sends` rows with `status='sent'`; `manual` → `Σ campaign_stages.sms_count` over sent, non-archived stages. Revenue/Cost/Clicks/Opt-outs are drawn identically for both modes on those two rows — only Sends branches. **Group rows don't use this view at all** (see the migration 0132 entry below).
- **Group rows no longer come from `unnest(offer_report_campaign_econ.group_ids)`** (migration `0132`). Before 0132, a campaign targeting multiple contact groups was counted FULLY in every one, not split — `offer_group_report_mv` rows summed to MORE than `offer_report_org_summary_mv`'s de-duplicated benchmark, and the API route's `offerTotals` (summed from those same rows) inherited the same inflation (10.2x on one measured offer). Group rows are now built directly per-recipient and the footer is read from its own matview — see the migration 0132 entry below for the current rule.
- **The twice-daily refresh cron is fixed-UTC (`0 5,20 * * *`) and drifts ~1h across DST**: 00:00 & 15:00 ET in winter (EST), 01:00 & 16:00 ET in summer (EDT). Acceptable for a historical, twice-daily report — the same fixed-UTC tradeoff CamMan already accepts for `telegram-report`'s Warsaw-time schedule; documented, not corrected.
- **Per-contact columns no longer share one rule** (migration `0132`). `Sent 7d/30d/90d` now shares the group-row economics' scope exactly — tracked campaigns that targeted this group, for this offer — a narrowing from before, when every in-app `stage_sends` row counted regardless of `link_mode`, offer, or whether the campaign even targeted the group. `Fresh pool` is a separate, all-time quantity (not a window): sendable (`messaging_status='eligible'`, not opted out) group members never sent a campaign of **this offer**, per `offer_exposures` (migration `0133` — see below). Only a send performed **entirely outside the app** (hand-entered `campaign_stages.sms_count`, no `stage_sends` row) is invisible to `Sent 7d/30d/90d`/`Fresh pool` **and** to group-row economics; the offer total and org benchmark still include it via `sms_count`.
- **`fresh_pool` is offer-scoped and sendable-only by design (migration `0093`); `0126` silently dropped both properties, and `0128`/`0132` carried the loss forward** — three migrations recreated `offer_group_report_mv` for unrelated reasons and each one re-emitted the drifted `fresh_pool` subquery without noticing it no longer matched the feature doc. The regressed version counted "no `status='sent'` row in the last 90 days, across **all** offers, no opt-out filter" — so a contact who opted out and was correctly never messaged again aged past 90 days and re-entered the pool permanently (measured: group 6/Nerve Pain showed 3,051 fresh, 3,034 of them opted out), and a contact who had merely gone quiet on a *different* offer was excluded from this one's count. Net effect: the ranking the column exists to support was inverted (AstroEnergy understated 4.3x, Memory overstated 30x). Migration `0133` restores `0093`'s definition. **The lesson: a doc that describes intent is a specification, not decoration — when the code and the doc disagree, the first job is to establish which one drifted, not to make the doc match whatever the code currently does.** `0132`'s own documentation pass got this backwards and rewrote the feature doc to match the broken SQL. This is the same class of regression, in the same migrations, as the `security_invoker` drop described above: `0126`/`0128` recreated a view/matview for one stated purpose and silently lost an unrelated property that had been deliberately set, and it took a dedicated migration to notice and restore it. `scripts/verify-offer-group-attribution.ts` criterion 7 now recomputes `fresh_pool` from base tables (not just re-reading the matview) and asserts it is offer-scoped, so this class of drift fails loudly instead of shipping.

### Offer group report attribution (migration 0132)

- A group row counts what reached contacts in that group. **The columns do not
  foot** — a contact in three groups is one send and three group-sends. The
  footer is read at offer grain, never summed. Do not "fix" a non-footing column
  by summing the rows; that was the defect.
- **`stage_sends.cost_per_sms` is NULL on ~33% of sent rows** (added after the
  fact). Never aggregate it as a cost source. Derive per-send cost from
  `campaign_stages.total_cost / (that stage's sent-row count)`.
- **`offer_report_campaign_econ` does not apply one consistent scope.** Tracked
  sends carry no stage-level filter; manual sends and cost require
  `sent_at IS NOT NULL AND archived_at IS NULL`; opt-outs are unfiltered. Anything
  compared against it must mirror it *per column*, not pick one predicate.
- **Attribution is restricted to `link_mode='tracked'`.** For a manual-link-mode
  campaign the footer counts `sms_count` while per-recipient rows count real
  sends, and the two are unrelated: campaign 110 has `sms_count = 0` against 889
  real send rows. Counting it gives a negative residual.
- **Group revenue/sales come from a different SOURCE than the footer's, not just
  a different grain.** Group rows use per-recipient `stage_sends.sale_revenue` /
  `converted_at`; the footer and org benchmark use `keitaro_stage_results.revenue`
  and `GREATEST(keitaro sales, stage_manual_sales.delta)`. Per-recipient covers
  ~97% of revenue (54,844 / 56,338 org-wide) and **~90% of the footer's sales
  basis** (815 attributable vs 908 campaign-grain, 89.8%) — quote that against
  `GREATEST(...)`, not against Keitaro sales alone (which reads ~96% and
  understates the gap). `offer_report_offer_totals_mv.attributable_revenue` /
  `.attributable_sales` carry the footer's own figures on the group rows' basis so
  the difference is measurable. They are **not** a whole-and-part pair with
  `revenue`/`sales` — never subtract them to derive an "unattributed" amount.
- **Group opt-outs can fall short of the footer for a reason no other column
  here has.** `opt_out_attributions.stage_send_id` is nullable by design (an
  attribution survives its send row being pruned); such a row has no
  recipient, so `cell_optouts` genuinely cannot place it in a group. The
  footer's own opt-out subquery in `offer_report_campaign_econ` joins through
  `oa.stage_id` instead and keeps these rows regardless. Not the grain
  difference the rest of this section describes — rows the group join can
  never reach at all.
- **`offer_report_campaign_econ` and `offer_report_tracked_campaigns` must
  carry `security_invoker = true`.** Without it the view runs as its owner
  and RLS on the underlying tables does not apply, exposing every org's data
  to anon/authenticated over PostgREST — the same class of ERROR-level
  Supabase advisor finding migration `0113` originally closed (see the
  Multi-tenancy section above). Migration `0113` set this on
  `offer_report_campaign_econ`; migrations `0126` and `0128` each silently
  reverted it by `DROP VIEW` + `CREATE VIEW` without carrying the option
  forward, leaving that advisor ERROR live in production until migration
  `0132` re-applied it and set it on `offer_report_tracked_campaigns` too.
  **Any migration that does `CREATE VIEW` or `DROP VIEW` + `CREATE VIEW` on
  either object MUST include `ALTER VIEW public.<view> SET (security_invoker
  = true);` in the same migration** — neither a bare `CREATE VIEW` nor
  `CREATE OR REPLACE VIEW` carries the option forward from the view's prior
  definition; it must be re-asserted every time the view is recreated, not
  set-and-forget. Re-run `get_advisors` (type=security) after any view DDL —
  the signal to watch is Supabase advisor check `0010_security_definer_view`
  at **ERROR**; it must report zero hits for these two views. Don't rely on
  memory that it was set once: `scripts/verify-migration-integrity.ts` now
  asserts `security_invoker=true` in `pg_class.reloptions` for both views
  directly, so this is checkable without a live advisor call.

## Reports rollup (migration 0112, see [04-features/reports-rollup.md](04-features/reports-rollup.md))
- **Bucketed by the SEND hour in ET, not the event hour.** Every metric (opt-outs, clicks, redirects, sales, cost) is attributed to the hour the message was SENT, so each rate is a batch rate ("of messages sent in hour H, X% opted out"). `date_trunc('hour', sent_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'` → the stored `bucket_start_utc`. Only ever done inside the bounded rolling-window build, never in a hot read.
- **Sales/revenue use the PER-RECIPIENT `stage_sends` attribution** (`converted_at`/`sale_revenue`), NOT the `keitaro_stage_results` daily aggregate — that's the only source that can be split by hour and group. It recovers ~93% of the authoritative aggregate (295 vs 319 sales; $20,982 vs $22,324); the read layer surfaces the delta so the structural gap isn't mistaken for a bug. This is a DIFFERENT sales basis than `/reports` and the offer-group report's footer and org benchmark (which use the aggregate); the offer-group report's group rows use the per-recipient basis (migration 0132), same as here.
- **"Clickers" = internal clean clicks** (`clicks.classification='human' AND scored_at IS NOT NULL`, joined via `stage_sends.link_id`), NOT the Keitaro visit counter (`campaign_stages.click_count`). Different populations — the two numbers will differ.
- **Grand totals come from `report_stage_hour` (Fact A) only.** `report_group_hour` (Fact B) fans out over the many-to-many `contact_contact_groups` (avg 1.34 groups/contact), so summing its group rows OVERCOUNTS the true total by design — same caveat as the offer-group report's group rows, which fan out the same way over a contact's multiple group memberships (migration 0132), not a group-id unnest.
- **`stage_sends.provider_phone_id` / `cost_per_sms` are durable send-time snapshots** (stamped at materialization). The rollup resolves `COALESCE(send snapshot, stage live value)` so pre-0112 history still attributes to a number/rate via the (mutable) stage. Cost inherits the flat-rate limitation of `campaign_stages.total_cost` (multi-segment messages under-costed) — a separate future card.

## Click scoring — ASN matching (see [04-features/tracking-attribution.md §7a](04-features/tracking-attribution.md))
- **Match datacenter ASNs by exact NUMBER. Never by organization-name substring.** The org-name fallback was removed 2026-08-11 after `"colo"` matched *NE COLORADO CELLULAR*, *COLORADO VALLEY COMMUNICATIONS* and *University of Colorado Hospital*, and `"google"` matched *Google Fiber Inc.* (a residential ISP). To improve detection, add the ASN number to `DATACENTER_ASNS` in [`lib/links/datacenter-asns.ts`](../lib/links/datacenter-asns.ts).
- **`CONSUMER_RELAY_ASNS` (Fastly 54113, Cloudflare 13335, Akamai 36183, Google Fiber 16591) are never datacenter** and win over `DATACENTER_ASNS`. The first three are Apple iCloud Private Relay egress partners — real recipients, converting at 2.24% vs a 0.97% human benchmark.
- **A false positive is worse than a miss.** A missed bot dilutes a metric; a false positive deletes a real customer from it, silently — it looks identical to successful filtering. When in doubt, don't classify as datacenter.
- **Rescore backfill ran 2026-08-11** (4,382 rows: 4,312 `suspect→human`, 70 `bot→suspect`). Any Hourly-Clickers or By-Group comparison spanning that date is not like-for-like.
- **~91% of all taps hinge on one signal** (datacenter ASN, weight 60 — almost entirely Google AS15169 SMS link scanners). If that signal shifts, every click metric on the platform moves at once with no other warning.

## Keitaro visit columns and their CamMan equivalents (see [04-features/tracking-attribution.md §7c](04-features/tracking-attribution.md))

Only `visit_clicks_clean` is ever rendered (as "Clickers"); `visit_clicks_raw` is
read into the funnel tally but reaches no screen.

When substituting a CamMan figure for a Keitaro visit count, scope it to
**human-classified** clicks. Measured 2026-08-24 over 284 healthy `guidekn.com`
stages:

| Keitaro column | CamMan equivalent | ratio |
|---|---|---|
| `visit_clicks_raw` | human click rows | 1.23x |
| `visit_clicks_clean` | `counted_clickers` | 1.35x |
| `visit_clicks_clean` | distinct contacts, any classification | **11.0x — wrong** |

The unfiltered distinct-contact count is ~11x the column it would replace,
because ~92% of taps are SMS scanners that never execute the landing page's
script. Using it would place an 11x-inflated number beside `counted_clickers` in
the same row.

## EPC — one denominator (see [04-features/epc-denominator.md](04-features/epc-denominator.md))
- **Every EPC divides by counted clickers.** A contact with ≥1 click scored `human`, OR a conversion (Rule F), deduplicated at the grain of the row displayed. There is no second denominator and no fallback: `withFunnelDerived` takes it as a REQUIRED parameter so the compiler, not a convention, prevents one reappearing.
- **Counted clickers are NOT additive** — across grains or over time. One person tapping two creatives in one campaign is one campaign clicker and two creative clickers; one person clicking on two days is one lifetime clicker. Never sum them; **re-aggregate with `COUNT(DISTINCT contact_id)` at the row's own grain**.
- **A claim on a card is not evidence either — re-verify before acting on your own earlier finding.** The offer-report card carried "the refresh cron has no error handling" into a build decision. The cron had gained a try/catch, a Tier-1 alert, a 500, and duration logging in the meantime. The note was true when written and nobody rechecked it. This is the same failure as the guard that ran against the wrong scope: **the check was real, the context moved.** Written notes, card text, commit messages, and prior measurements all decay — re-read the file before you build on what you wrote about it.
- **An aggregate row must dedup at ITS grain, not add up its parts.** Summing per-stage counts into a dimension row double-counts anyone who clicked more than one stage — measured at +38.6% (By Number), +27.2% (By Offer), +7.4% (By Sequence) before this was fixed. That divergence was once documented as "expected non-additivity"; that framing described a shortcut, not a grain decision.
- **A table may legitimately not foot.** The offer report shows group cells, an offer footer and an org benchmark in one column; each deduplicates at its own grain, so the footer is smaller than the sum of the rows. Do not "fix" this by summing — say it in the UI. This was true of clicks alone through migration 0128; **migration 0132 extended it to every column** (sends/revenue/sales/cost/optouts) on the offer report, so no column there foots to the offer total any more — see [the migration 0132 entry above](#offer-group-report-attribution-migration-0132).
- **By Group is the one exemption**, by construction: its metrics are fractional shares split across a contact's groups, and a fraction has no set to dedup. Labelled in the UI as not comparable with the other tabs.
- **The relay carve-out lives in the scorer, not in reporting.** By the time a click reaches the denominator the rule has collapsed to `classification = 'human'`. Do not re-implement ASN logic in a reporting query.
- **Manual-mode campaigns fall back to Keitaro `visit_clicks_clean`** (they mint no links). Comparable in scale: only 11% of Keitaro landing visitors are CamMan-excluded.
- **The cache refresh is tied to the Keitaro poll**, not an independent schedule — otherwise EPC drifts between rebuilds and snaps back, which reads exactly like a real trend.
- **Freshness is two values**, `updated_at` and `full_rebuild_at`. Never collapse them into one "last updated": an indicator that overstates staleness gets ignored, then is useless when it is right.
- **Lifetime EPC is primary**; period EPC attributes revenue by the CLICK's date, not the sale's.
- **Every surface names its time basis in the UI.** `EPC (all time)` / `EPC (period)` / `EPC (30d)`. A bare "EPC" is not acceptable — the denominator is unified but the WINDOW is not, so the basis has to be readable.
- **The creatives picker sorts by the 30-day figure and says so** (`EPC (30d) ↕`); the lifetime column is shown but deliberately NOT sortable. The picker decides what gets sent next, recency predicts that better, and sorting by lifetime would move rankings by a mean of 4.17 places — a send-behaviour change must never arrive as a side effect of a display change.
- **A column with `enableSorting: true` MUST have a matching entry in the route's server-side sort whitelist.** Without it the request is accepted, the route silently falls back to sorting by revenue, and the header still responds — it looks like it works. Guarded by `scripts/verify-sortable-columns.ts`.

## Delivery receipts — capability is DECLARED, and absence renders `—`, never `0%` (see [04-features/delivery-report.md](04-features/delivery-report.md))

- **One layer under every surface.** [lib/reporting/delivery.ts](../lib/reporting/delivery.ts) is the only place delivery is counted. `/reports/delivery`, the Overview `Delivered %` column, and the undelivered tripwire (`/api/cron/tells-monitors` check #4) all read it, so the page and the alert cannot disagree. Do not add a second delivery query.
- **Rows come from the registry; capability comes from a declaration whose default is "none".** `DLR_SOURCES` maps `sms_providers.sms_provider_id` → capture table. A provider absent from the map has no DLR intake. A new provider row therefore appears in the report as `—` on day one and only lights up when someone deliberately registers its source.
- **A provider with no source reports `null`, not `0`** — enforced by the type (`number | null`), not by the UI hiding a computed zero. `txh`/`txh2` have **no DLR table at all** and carry ~99.9% of volume: an ungated computation renders 568,659 sends as `0.0% delivered`, which reads as a total platform outage.
- **Fold to one terminal status per message BEFORE joining to sends.** `textrequest_dlr_events` gets a row from the per-message callback *and* another from the reconcile poll — 158 rows for 50 messages. Row-counting reports 298% delivered. `delivered` beats `undelivered` when both exist.
- **"No receipt" is `NOT (delivered OR undelivered)`, not "no matching event row".** A Tells message emits a non-terminal `sent` before `delivered`, so it can have an event row and no receipt. The wrong definition reported 0 where the truth was 14.
- **⚠️ Attribute the NUMBER from the send, not from the stage.** `stage_sends.provider_phone_id` is stamped from the stage row read once per materialization INVOCATION, materialization is RESUMABLE across invocations, and nothing guards `campaign_stages.provider_phone_id` against being edited in between (the stage PATCH locks `scheduled_at` only). Partially-materialized stages genuinely occur. So a stage CAN legitimately send from two numbers — 0 of 882 today, but incidentally, not structurally. Deriving the number from the stage would silently credit all of that stage's sends to whichever number the stage holds now, precisely on the number under investigation. The CAMPAIGN, by contrast, is safe to derive from the stage — that link is a FK. Cost of the wider `(stage, phone)` grain: +8.4%.
- **A campaign can span providers.** Campaign-grain percentages are computed over DLR-capable sends only **and labelled with their coverage** (`91.4% (of 4% of sends)`) — a 4%-coverage figure is otherwise indistinguishable from a 100% one. Capability is per-provider, so every number under a provider inherits it: two numbers can differ in deliverability, never in measurability.
- **The window cap is a measured constraint, not a preference.** 7 days = 473 ms; 30 days = 11.0 s (the `stage_sends` scan; `stage_sends_org_sent_at_idx` doesn't cover `status`/`stage_id`). `/api/reports/delivery` caps at 14 days and the Overview column is skipped past that cap. `campaign_stages.sms_count` is `0` on every API-send stage, so there is no pre-aggregate shortcut. Raising either cap needs the covering index first.
- **Monitor thresholds are per-number, not per-platform.** The 8% undelivered tripwire is calibrated to the `tls` toll-free number's observed 5.8% baseline. A provider with no baseline gets **no** threshold rather than inheriting 8% — an uncalibrated monitor is a muted monitor.

## Verification — a passing check is not evidence until you know what it ran against

Three times in the EPC workstream a check was **correct and passing while running against the wrong input**:

1. A verification harness used a `max: 1` connection pool and ran four monitors under `Promise.all`, one holding a transaction. The others queued behind it forever. It looked exactly like a slow query, and two query "optimisations" were made chasing a phantom.
2. A sortable-column guard passed against a **14-column set that excluded the very columns it was written for** — the branch had been cut from `main` before the columns merged.
3. A snapshot script's format change reported success from an unconditional `print` while the string replacement had silently not matched; the output file was unchanged.

All three were caught, but only because the output happened to print enough detail to notice. That is luck, not process.

**Rules:**
- **Guards MUST print their input scope by default** — how many items, which ones, over what window, from which branch or table. `verify-sortable-columns.ts` prints the column names it found; `propagate-clickers` logs its `scope` string; the counted-clicker verifier prints the row counts it compared. A bare `✓ passed` is not an acceptable output.
- **Treat an empty or zero-item scope as a FAILURE, not a pass.** Finding zero sortable columns means the parser broke, not that everything is fine. Assert non-emptiness explicitly.
- **Before trusting a green check, confirm what it examined.** Read the count and the names, not just the tick.
- **Confirm the base commit before building on a branch.** `git worktree add ... origin/main` uses whatever `origin/main` was last fetched, which may be several merges stale.
- **`now()` is FROZEN inside a transaction — a time-sensitive fixture must use `clock_timestamp()`.** Postgres's `now()` is `transaction_timestamp()`: it returns the instant the transaction began and never advances, however long the transaction runs (measured 2026-08-17: unchanged across 65s while `clock_timestamp()` advanced normally). Test harnesses here wrap a whole suite in one rolled-back transaction, so any fixture computed from `now()` is stamped with a time that is minutes stale by the point it is used. This made `verify-drain.ts`'s quiet-hours case **red on main**: it built a "closed" send window at `now_min + 1` from the frozen clock, real time had long since passed that minute, the window was therefore genuinely OPEN, and the drain correctly sent — failing an assertion that the drain must not send. The product was right and the test was wrong, which is the expensive direction. Fixed with `clock_timestamp()` **plus 5 minutes of slack**, because a `+1` boundary can still be crossed while the fixture rows insert. Two general rules fall out: build any time-relative fixture from `clock_timestamp()`, and give a boundary condition slack far larger than the setup cost rather than exactly one unit.
- **A time-sensitive assertion must PRINT the window it built.** `verify-drain.ts` now logs `window built: [1047, 1439) ET · current minute 1042 (outside)` before asserting. Without it, the failure said only "something sent" and diagnosing it required a detour through transaction-timestamp semantics; with it, the stale window is visible in the output. Same rule as the input-scope rule above, applied to time.
- **Cleanup must ASSERT, not hope.** Teardown runs *after* the assertions have printed `ALL PASS`, which is exactly when nobody is reading. On 2026-08-17 the provider-collision probe finished green and its cleanup then failed silently — `DELETE … WHERE id = ANY(${jsArray})` throws `ERR_INVALID_ARG_TYPE` under postgres-js (it will not bind a JS array to `ANY()`), so the `DELETE` never ran and the probe row survived in the database. Delete with scalar binds, then **re-query and fail the run if anything is left**. A teardown whose failure is invisible is worse than no teardown, because the green result actively argues that nothing was left behind.

## Probes that WRITE run against the demo database, not production

Read-only probes may run against production. **Anything that writes — even a self-cleaning probe row — is a production data write and falls under the standard approval carve-out: explicit per-instance OK, same as a backfill or a migration.**

Default target for destructive-or-writing probes is the **`camman-v2` demo database**, not prod. The rule exists because the failure mode is not the write, it is the cleanup: see the assert-your-teardown rule above, where a "low-risk, self-cleaning" probe left a real row in the production `sms_providers` table because the delete silently no-op'd. Low risk is not no risk, and the cost of being wrong lands on live data.

If a probe genuinely must run against production (it depends on real credentials, real volumes, or real provider state), ask first, keep the write set as small as possible, and verify the teardown by re-querying rather than trusting it.

## A segment rule type must be registered in SEVEN places, not four

This section previously said FOUR. Building the `contact_attributes` rule types (0147/0148) found
three more, and the two new ones are the dangerous ones.

| # | place | file |
|---|---|---|
| 1 | `RULE_TYPES` | [lib/validators/segment-rule-types.ts](../lib/validators/segment-rule-types.ts) |
| 2 | `validateValueByShape` | [lib/validators/segment-rules.ts](../lib/validators/segment-rules.ts) |
| 3 | `isRuleComplete` | [lib/segment-rules-eval.ts](../lib/segment-rules-eval.ts) |
| 4 | `verifyValueOwnership` | [lib/api/segment-rule-value-ownership.ts](../lib/api/segment-rule-value-ownership.ts) |
| **5** | **the SQL emitter** (`buildRuleClause`) | `lib/segment-rules-eval.ts` |
| **6** | **`segment_rules_rule_type_check`** | a DB CHECK — needs a MIGRATION |
| **7** | the same CHECK mirrored | [db/schema.ts](../db/schema.ts) |

**Miss 5 and the rule saves, renders, and matches NOBODY** — it validates all the way through and
then falls into the emitter's `default` branch, which returns a contradiction.

**Miss 6 and the rule is UNCREATABLE**: it passes Zod, passes ownership, renders in the UI, and
Postgres rejects the INSERT with a `check_violation`. This is the same failure that shipped
`phone_type` / `carrier` uncreatable in 0098, one layer deeper — and nothing asserted these lists
agreed until [scripts/test-segment-rule-type-registration.ts](../scripts/test-segment-rule-type-registration.ts),
which compares RULE_TYPES ↔ `db/schema.ts` ↔ the live DB constraint in both directions. **It must
be green before any rule-type PR merges.**

Places 2, 3 and 4 all fall through to a `typeof value === "number"` test, so a **set-shaped** value
(array/object) is silently mishandled unless explicitly branched — that has not changed.

⚠️ **A `is_not` rule dropped by `isRuleComplete` turns "nobody" into "EVERYBODY"** under `EXCEPT`.
`isRuleComplete` must stay identical-or-stronger than what the emitter accepts.

## contact_attributes — age is DERIVED, and under-18 is scoped to the rule

- **`contact_attributes` is 1:1 with `contacts`** (`contact_id` IS the PK, migration 0147). No
  column was added to `contacts`. Populated only by drip intake and mapped CSV uploads; there is
  **no backfill**.
- **Phone is the identity; everything there is an attribute.** `email` has **no unique constraint** —
  partners legitimately submit shared addresses, and a unique index would make an import FAIL on a
  duplicate rather than update it.
- **Age is NEVER stored.** Bands are a **RANGE on `dob`**, computed once per query:
  `dob > ET_today - (maxAge+1) years AND dob <= ET_today - minAge years`. A per-row
  `EXTRACT(YEAR FROM age(dob))` is not sargable and kills `contact_attributes_org_dob_idx`. Same
  technique as the per-carrier daily cap (0143). Anchored to the **ET calendar date**, like the rest
  of the send path. `lib/contact-attributes.ts` holds the read-side twin of that arithmetic — the
  two must agree, or a displayed band contradicts a targeted one.
- **Under-18 is scoped to the `age_band` rule, NOT global.** Inside it a NULL `dob` matches nothing
  and a hard 18-year floor applies independently of the band chosen (so a future band edit cannot
  lower it). ⚠️ **A GLOBAL "unknown dob = minor" filter would exclude 100% of the audience** —
  measured 2026-08-22 there were 815,426 contacts and **zero** with a `dob`. If a global minor gate
  is ever added its form is *"exclude where `dob` is KNOWN and under 18"*.
- **`1970-01-01` normalizes to NULL at the write boundary.** The `CHECK (dob > '1900-01-01')` cannot
  catch it — that is a legitimate birthdate — so `normalizeDob` is the only thing that does. Storing
  it would manufacture a 56-year-old cohort out of blank spreadsheet cells.
- **The attribute CSV import UPDATES existing contacts and NEVER creates one.** A mis-mapped column
  can mangle attributes but can never grow the audience. Unmatched phones are reported, not
  inserted. It is a **separate endpoint** from the four `PhoneUploadForm` flows on purpose — adding
  a mode to that shared component would have risked contacts/opt-outs/opt-ins/clickers for no
  shared behaviour. Only MAPPED fields are written (`COALESCE(EXCLUDED.x, ca.x)`), so a CSV without
  a `state` column does not blank a state we already know.

## Stage destinations are built at MINT time from the campaign's brand (1b, 0150/0151)

A stage stores **which page** (`campaign_stages.landing_page_id`), not which URL. The destination is
constructed when links are minted, from the campaign's brand **at that moment**.

**Why.** On 2026-08-22 campaigns 902 (Guide Kin→LumZen) and 923 (FitsYou→LumZen) were re-branded in
production and every one of their stages kept pointing at the OLD brand's landing pages — because
the destination was a frozen absolute URL. Building it late makes a rebrand self-correcting. It also
collapses the duplication operators maintain by hand today: offer 58 carries `gdkn-Monks`,
`lmzn-Monks` and `fty-Monks` — the same page once per brand.

- **`landing_page_id` NULL ⇒ EXACTLY today's behaviour** (build from `offers.sales_pages` / the
  stored `full_url`). No backfill; all 1,198 pre-existing stages stay NULL, including the 11 flagged
  for manual review.
- **`brands.landing_host` is a separate column, NOT derived from `brands.website`.** `website` is
  unnormalized — `https://www.guidekn.com`, `https://www.lumzen.co/`, `https://fitsyou.net/` (mixed
  `www.`, mixed trailing slash) — so prefixing `www.` yields `www.www.guidekn.com` for two brands and
  using it as-is gives FitsYou a host that differs from the `www.fitsyou.net` production actually
  mints. `website` is ALSO consumed verbatim by `lib/links/root-redirect.ts`, so normalizing it in
  place would change the bare-root redirect. **A brand with NULL `landing_host` cannot use a
  `kind='slug'` page** — refusing beats guessing, because a wrong host ships a 404 that silently
  kills attribution.
- **`kind='external_url'` is used verbatim for any brand** and needs no landing host.
- **`buildLandingPageUrl` is PURE and shared** by the stage editor's read-only preview and the send
  path's mint. If they diverged, an operator could approve one URL while the recipient receives
  another.
- **No DELETE on a landing page.** Deleting one would `SET NULL` and silently drop its stages back to
  the legacy path. Disable instead — the slug stays reserved (the unique index is NOT filtered on
  status), so links already in the wild keep meaning what they meant.
- **A page's `kind` is immutable.** Flipping a live page between slug and external_url would change
  where every stage already pointing at it sends, including approved ones.

### UTM tags never reach an `/lp/` destination

The canonical shape allows exactly ONE query param (`sub_id3`), which already carries tracking. The
one UTM tag configured in this org is `tag_id: "subid3", value_source: "sub_id3"` — appending it
emits the literal `subid3=sub_id3`, which is precisely the "unsubstituted template placeholder"
defect `validateDestination` names and the single row that fails the 0151 CHECK.

⚠️ This also fixed a **pre-existing latent break**: 261 stages carry UTM tags on `/lp/` destinations,
and re-deriving any of them in auto mode would have produced a URL the very next line rejects as
`invalid_destination`. Tags still apply to `external_url` destinations, where no shape rule exists.

### Re-branding a campaign

Allowed, and it reports what went stale (`brand_change_impact` on the PATCH response):

| what | self-corrects? | behaviour |
|---|---|---|
| landing-page destination | **yes** — built at mint from the brand | nothing to do |
| sending number | **no** — a deliberate per-stage choice | **approval/activation BLOCKED** until changed |
| legacy absolute `full_url` | no | **warn only** |

⚠️ **The number block is WRITE-TIME ONLY, never send-time.** An already-approved stage with
materialized rows keeps sending — blocking at dispatch would strand real messages, the same rule 1a
follows. `computeBrandChangeImpact` (the warning) and `isStageNumberBrandStale` (the block) share
one query so the warning can never disagree with what is enforced. **This closes the 1a gap** that
the two production rebrands realised: 1a grandfathers by "the (brand, number) pair is not changing",
which is right for the campaign row and silent about its stages.

Guarded by the rebrand section of
[scripts/test-brand-number-guard.ts](../scripts/test-brand-number-guard.ts), which asserts the
warning and the block **agree** (a warning that disagrees with what is enforced is worse than no
warning), that a shared NULL-brand number and a stage with no number are both left alone, and that
a stage on a landing page is not warned about because mint-time construction self-corrects it.

## Two selectors already partition the world — use the seam, don't add a flag

Adding drip stages to `campaign_stages` risked touching the live send path. It did not, because the
two selectors are already mutually exclusive on one column:

    Phase A (materialize)  materialized_at IS NULL      AND sent_at IS NULL
    Phase B (drain)        materialized_at IS NOT NULL

A drip stage created with BOTH stamped is invisible to the first and permanently drainable by the
second. **No `type` filter was added to either file**, so neither can drift.

**⚠️ The corollary: nothing in either file mentions drip, so nothing in either file would fail if
that property broke.** A future edit to either predicate could silently double-materialize drip
stages or strand them forever. `scripts/test-drip-sends-schema.ts` replays both real predicates
against a synthesized drip stage, with controls proving an unstamped stage is the mirror image.

## A compliance gate that runs once per batch must move inside the loop

`kickoff.ts` checks opt-out language once per stage, which is right when every recipient gets the
same body. Drip renders per lead, so the same check moved inside the loop — and **fails closed per
row**: a refusal drops that lead and leaves its journey untouched for the next tick. Refusing the
whole batch would let one bad render block 199 good leads.

`optOutGateSubject` already took a rendered body; only its call site was stage-shaped.

## When a fail-safe has a direction, test the direction, not the feature

`checkOptOutRateBreaker` skips the latch for drip campaigns. It has four live callers, all opt-out
ingesters. A test proving "drip skips" would pass on an implementation that skipped for
**everything** — which would silently remove opt-out protection from real campaigns with nothing
else noticing.

So the guard asserts all three: a regular campaign still latches, an **unknown/unreadable** type
still latches, and only a positive read of `'drip'` does not.

## Two definitions of the same thing will drift — give them one builder

"Contacts in use" was defined independently in two places: `iu_set` in
[lib/audience-snapshot.ts](../lib/audience-snapshot.ts) (the campaign-level flag) and
`applyInUseExclusion` in [lib/segment-rules-eval.ts](../lib/segment-rules-eval.ts) (the per-segment
flag). They agreed only by coincidence — both read `campaign_audience_pool` for active campaigns.
Adding drip journeys to one would have given two answers to one question from one product.

Both now call `lib/drip/in-use.ts`. **When you find two implementations of one concept, the fix is
one builder, not two careful edits.**

## To prove a change is invisible, make the SQL identical — then pin it

R14 required that adding drip leave regular-campaign activation UNCHANGED. Measuring "close enough"
was not it: always-UNION-ing an empty drip branch preserved the subplan exactly but added an outer
dedup pass, **+13% plan cost**. Emitting the branch **only when the feature is switched on** makes
the off-path byte-identical by construction, which needs no re-justification at future reviews.

**That guarantee is invisible in the code**, so `scripts/test-drip-in-use-sql-shape.ts` freezes the
pre-change text as a literal and compares. It asserts BOTH directions — off must equal the frozen
text, on must actually emit the branch — because a one-sided test would pass if the feature were
never wired at all.

## Make the central rule an INVARIANT, not a property of the code

"A lead is routed to exactly one campaign" is enforced by a partial unique index
(`drip_journeys (org_id, contact_id) WHERE state IN ('routed','active')`), not by the routing
worker. Everything else about routing is policy in code that can be raced, retried, or called twice.
The worker can therefore be optimistic and treat a `23505` as "lost the race, skip" — **it is
allowed to be optimistic precisely because the index is pessimistic.**

Partial, so a terminal journey frees the contact for re-entry — asserted in BOTH directions, since
an index that only ever refused would pass a one-sided test while breaking re-entry forever.

## A debugging tool must call the code it explains

The "why not routed" tool calls the same `evaluateLeadRouting` the router calls. A separate
explain-path is a second implementation of the rules, and the first time the two drift the tool
confidently explains a decision that never happened. It also does not short-circuit: knowing a lead
failed the tag check tells you nothing about whether it would also fail three other rules once you
fix the tag.

**Report the third state.** A filter the campaign set but the lead has no value for is `missing`,
not `mismatch` — one is fixed by the partner sending the field, the other by changing the targeting.

## Caps over different windows need different names

Drip carries three: lifetime journeys, journeys admitted per ET day, and sends per ET day. They are
not interchangeable — a journey routed at 23:50 ET sends the next day — so enforcing a send cap
against journeys would have two caps fighting over one field. They are named apart in the schema,
the reason JSONB and the UI, and **the UI states which are live and which is not**: a cap that
silently does nothing looks like protection.

## A worker that parks a row must be able to un-park it

`lead_inbox` has a `received` -> `awaiting_lookup` -> `processed` path, and the claim only re-picks
an `awaiting_lookup` row **once its lookup is complete**. So a row parked in that status without
ever being enqueued is stranded silently, forever. When the drip lookup sub-cap is exhausted the
sweeper therefore leaves the row as `received` — untouched except for the saved `normalized`
payload — so the next tick reclaims it naturally.

**The general rule: before moving a row into a waiting state, check what condition moves it OUT.**
If that condition is created by the same step you just skipped, the row will never leave.

## Alerts must ship WITH their consumer, and must be cleared by whatever fixes them

An alert whose condition is true by construction trains people to ignore it. The drip backlog alert
was deliberately held back from Phase 2 — nothing drained `lead_inbox` in that phase, so
"unprocessed for > 10 min" would have fired on the first lead and never cleared. It shipped in
Phase 3 alongside the sweeper.

Equally: a state-transition-gated alert that nobody resets latches `firing` and silences the NEXT
incident. Partner-key rotation clears the auth-failure alert; a recovered Telnyx balance clears the
top-up alert.

**Related failure: distinct causes must not share a counter.** The drip monitor counts `received`
backlog separately from `awaiting_lookup`, because the first means the sweeper is dead and the
second means the Telnyx side is stuck. Summed, a stalled lookup hides inside a healthy-looking inbox.

## Rate limiting and counters — put the decision IN the statement

`lib/api/rate-limit.ts` is an **in-memory** token bucket and cannot enforce anything in serverless;
its own header says so ("the effective rate is instance_count * limit"). Any real limit needs shared
state, which means the database.

**The counter shape matters more than it looks.** The allocation shape used by
`campaign_tracking_counters` increments unconditionally:

```sql
ON CONFLICT (...) DO UPDATE SET next_seq = next_seq + 1 RETURNING (next_seq - 1)
```

Used as a **limiter** that is wrong in a way an allow-path test cannot see: a client hammering while
already over the limit keeps incrementing, so **rejected requests burn the quota**. Put the decision
in the statement instead:

```sql
ON CONFLICT (...) DO UPDATE SET count = count + $n
  WHERE count + $n <= $limit
RETURNING count
```

No row returned ⇒ refused, atomically, with nothing consumed. **⚠️ The `INSERT` branch is not
covered by that `WHERE`** — the first call of a window inserts unguarded, so the caller must
pre-check size. Both halves are asserted in `scripts/test-intake-schema.ts` (the refusal is checked
by *absence of a row* AND by the counter being unchanged afterwards).

The same construction gives **state-transition-gated alerts**: `WHERE alert_state.state <> $new`
returns a row only when the state actually changes. Before `alert_state` (0154) nothing in the
codebase suppressed repeat alerts — `notifyTelegram` is stateless and the breakers only avoid storms
as a side effect of latching. **Whatever resets the condition must also clear the alert**, or the
next genuine incident is silent; partner-key rotation does this explicitly.

**The latch is claimed on DELIVERY, not on detection.** `notifyTelegram` never throws and
returns `false` on unset config, a non-2xx, a network error, or its timeout. If the latch
flipped when the condition was *noticed*, a send that failed on that one tick would be lost
forever — the next tick sees no transition and stays silent, and a condition that never
resolves never re-arms. So `notifyOnTransition` claims a send when the alert is newly firing
**or** firing-but-never-delivered, and writes `last_notified_at` only after the send is
confirmed.

**If you gate state on "we told someone", you MUST check `notifyTelegram`'s boolean.** About
twenty call sites discard it and are right to — they are best-effort notifications with nothing
riding on them. The rule is for new callers that latch, suppress, or otherwise make a decision
based on delivery. Ignoring it there re-creates the bug above.

**A duplicate is possible on any concurrent claim, not only a post-failure retry.** Two callers
racing a fresh transition into firing can both win, the same way two overlapping retries can —
the old state-only gate's atomic single-winner guarantee is deliberately traded away here, for
every caller. Accepted: a duplicate beats a silent loss.

**Not fully covered:** callers that are event-driven rather than periodic retry only when the
event recurs. `app/api/intake/leads/[token]/route.ts` is the one such caller today — if no
further auth failure arrives, its alert is still lost. A sweeper over
`state='firing' AND last_notified_at IS NULL` would close that; it is not built.

## Hash vs encrypt a credential — ask whether you must REPLAY it

`lib/crypto/secret-box.ts` (AES-256-GCM, `PROVIDER_CREDENTIALS_KEY`) exists because
`provider_credentials` must be **replayed** to a provider. A credential that is only ever
**verified** — a partner intake secret — should be **hashed**, not encrypted: a dump then yields
nothing, and rotating the master key does not break every partner.

**⚠️ For a high-entropy machine-generated secret, use a fast hash (SHA-256), not bcrypt/argon2.**
Slow KDFs defend low-entropy human passwords against offline brute force; 256 bits of
`randomBytes` has nothing to stretch. At 50 req/s, bcrypt cost-10 costs ~5 CPU-seconds per
wall-clock second — a self-inflicted DoS on a function billed by CPU time.

Related: an **addressing** value (a lookup token) stays plaintext and indexed; only the
**authenticating** value is hashed. Hashing the token would turn resolution into a seq scan.

## Capture-raw endpoints: store what fails, too

An intake that drops malformed payloads at the edge makes a broken partner integration invisible.
`lead_inbox` stores rejects with `status='rejected'` and an `error`, and its `dedup_key` is
**nullable with a partial unique index** precisely so a lead with no parseable phone can still be
written. A `NOT NULL UNIQUE` dedup key would reject exactly the leads most worth keeping.

**⚠️ Multi-row `INSERT ... ON CONFLICT DO UPDATE` requires intra-batch dedup.** Postgres raises
`21000` ("cannot affect row a second time") if one statement conflict-updates the same row twice, so
one repeated key inside a 500-row batch would fail the entire call. Collapse duplicates before the
statement and re-expand results to the caller's original order.

## Test fixtures — never a live entity, and never production for a write

Two rules, both learned the same way: on 2026-08-21 a smoke test of the new brand → number
guard PATCHed **stage 3031**, a draft behavioural child on the **active** campaign 902, to prove
the guard rejected a cross-brand number. It did not reject — the stage already carried that
number, so the grandfathering path correctly skipped the check — and the request instead changed
`provider_phone_id` 114 → 27 and nulled `sms_provider_id`. The new guard then refused to put the
original number back (the pair was now "changing"), so restoring it took a hand-written SQL
`UPDATE` against production.

**1. Never mutate a live or active-campaign entity as a test fixture.** Prove the behaviour with
a request that must be **REJECTED** — a 4xx writes nothing by construction, so the test is
inherently safe and needs no cleanup. When a write genuinely must happen, use an **archived or
completed** entity with zero `stage_sends` rows, and record its exact prior values *before* the
call so a restore is possible.

Corollary, and the part that actually bit: **a passing 2xx is not evidence the guard ran.** A
grandfathered path, an absent field, or a short-circuit all produce the same 200 as a working
allow. Before reading a 2xx as "allowed", confirm the code path you meant to exercise was
actually entered — here, that the pair was changing at all.

**2. A smoke test that must WRITE runs against the `camman-v2` preview database, never
production.** That is what it is for — see [preview-environment.md](preview-environment.md). It is
disposable, structurally identical to production, and carries synthetic data. Production is for
**read-only** verification: `SELECT`s, and API calls whose expected outcome is a rejection.

The same discipline applies to the residue check afterwards. A restore is not finished when the
row looks right — re-verify the surrounding invariants too (here: the count of stages on the
number, that no row was left with a phone but a NULL provider, and that the pending send-row
counts were untouched), because the failure you caused is rarely the only thing your request
touched.

## Working copy — do multi-step work in a throwaway worktree, never in `C:/AFF/camman` directly

`C:/AFF/camman` is a **shared checkout**. More than one agent session works in this repo at a time, and any of them can move its `HEAD` between two of your commands. Git offers no warning and no lock.

The failure this produces is quiet and lands on someone else's work. On 2026-08-12 a session ran `git checkout -b` and committed, and by the time it ran `git branch -m <newname>` a concurrent session had switched the shared checkout onto *its* branch — so the rename retargeted and renamed **the other session's branch**. `git branch -m <newname>` renames whatever `HEAD` currently points at; it never errors, it just silently hits the wrong thing. Uncommitted edits are worse: they follow `HEAD` and can end up staged onto a branch they have nothing to do with.

**The rule: for any task beyond a single read-only command, work in your own worktree.**

```sh
git fetch origin
git worktree add -b <branch> .claude/worktrees/<name> origin/main
```

- **Branch from `origin/main`, never local `main`** — local `main` runs far behind and is checked out in another worktree anyway (see the base-commit note above).
- **Worktrees have no `node_modules`** (they share `.git`, not dependencies). Junction the shared one instead of a multi-minute install:
  `cmd //c "mklink /J node_modules C:\AFF\camman\node_modules"`
- **Remove that junction with `cmd //c "rmdir node_modules"`, NEVER `rm -rf`.** `rm -rf` follows the junction and deletes the main checkout's dependencies. Unlink *before* `git worktree remove`.
- **Clean up when the branch merges:** `git worktree remove <path>` then `git worktree prune`. Stale worktrees are not free — repo-wide `npm run lint` walks every one of them.
- Prefer explicit two-argument git forms (`git branch -m <old> <new>`) over "operate on the current branch" forms, which silently follow a `HEAD` you did not move.
- **Run every git command as `git -C <absolute worktree path> …` — never a bare `git` relying on the shell's current directory.** Having a worktree does not protect you if the command executes somewhere else. The agent shell's cwd is **not reliably persistent between tool calls**: it can silently reset to the repo root, so a `cd <worktree> && git …` that worked in one call runs against the **shared checkout** in the next. That is how the 2026-08-17 incident happened — a `git branch -m` intended for a worktree branch renamed the shared checkout's branch instead (restored immediately; no commits or working-tree changes lost). `git -C` binds the target explicitly and is immune to cwd drift.

If you do disturb another branch, the fix is usually clean — a rename touches no commits and preserves upstream config, so `git branch -m <wrong> <original>` restores it. Say so plainly rather than quietly correcting it; the other session may be mid-task.

## Date stamps come from the current date, never from the data you're looking at

Every `_Last updated:_` header, changelog entry, and "measured on" comment takes its date from the **current date in context**. Never from a timestamp inside the data you happen to be querying.

On 2026-08-17 a whole workstream — changelog entry, two doc headers, a `MEASURED` comment on a live classifier, a test's fixture-provenance note — shipped stamped `2026-08-14`. The wrong date came from the production data being examined at the time: the most recent `stage_sends.sent_at`, the newest migration rows, the last deployment. All of those legitimately said the 14th. None of them said what day it was.

**Data tells you when things happened. It does not tell you when you are.** The failure is quiet — a plausible recent date attracts no scrutiny — and it corrupts exactly the records whose only job is to establish sequence. A "measured 3 days ago" note on a classifier pinned to a live provider's response format is worse than no date at all.

Related: `docs/CHANGELOG.md` is **newest-first**. Append at the top, under the intro — not at the bottom, where the same commit also put it.

## `gh pr checks` exits non-zero while checks are pending — never map that to "no results"

`gh pr checks` returns a **non-zero exit code when checks are pending or failing**, not only on invocation error. So the natural-looking defensive idiom is a trap:

```sh
s=$(gh pr checks "$PR" --json name,bucket || echo '[]')   # WRONG
```

Every pending poll takes the fallback, the loop sees an empty result forever, and a 15-minute watch reports **nothing at all** — indistinguishable from "no checks configured" or "still running". That happened on PR #69; the checks had in fact gone green minutes in.

Use `gh pr view <n> --json statusCheckRollup,mergeStateStatus`, which exits zero regardless of check state, and **report every terminal state, not just success** — a watcher that only greps for green is silent through a failure, and silence reads as "still running". See the worktree/monitor guidance above for the general form.

## Verification tooling gets guard-grade treatment - it is not throwaway

The scripts that check the work fail in the same ways the work does, and a broken checker is worse than no checker because it reports success. Over one session, verification tooling produced: a watcher that ran 15 minutes and emitted nothing (a `|| echo '[]'` fallback swallowed every poll, because `gh pr checks` exits non-zero while checks are pending); a success test that matched `api.github.com` inside an *error* URL and declared a failed PR creation successful; a 10-minute poll loop that measured nothing because it piped to standalone `jq`, which is not installed; and an `eslint $FILES` with an empty `FILES` that silently linted the entire repo and reported 216 unrelated problems.

None of these were wrong about the system. All of them were wrong about themselves.

**Rules, same bar as production guards:**

- **A missing binary or an empty variable is an ERROR, never an empty result.** `jq` absent, `FILES` empty, a command not found - fail loudly. Prefer `gh --jq` over piping to `jq`; check the variable is non-empty before using it to select what gets checked.
- **Print the input scope.** How many items, which ones, over what window. A count you can sanity-check is what catches the empty-variable case.
- **Assert non-empty before asserting equal.** Two empty sets are equal. A non-empty baseline check belongs above every comparison.
- **Never map a failure to a benign value.** `|| echo '[]'`, `2>/dev/null` on the thing you are measuring, a `catch` returning a default - each converts "I could not tell" into "nothing to report".
- **Match success on a positive signal, not the absence of a known error string.** A URL, an exit code, a parsed field - not "does the output contain the word I expect".

## An unexplained detail in a PASSING run is a finding, not noise

A suite that prints `ALL PASS` is not a licence to stop reading it. Chase any number in the output you cannot immediately account for.

Two defects in this workstream were found exactly that way, and neither would have been caught by the assertions:

- A count line read **3** where the codebase said 2. The suite passed — the count was incidental detail printed for context. Chasing it surfaced an unknown 8th provider row, and through it the fact that **`POST /api/providers` never wrote `adapter_code`**: every provider created through the connection-type picker was landing unsendable, because the picker shipped before the column existed. No test asserted the happy path produced a *usable* row, so nothing failed.
- A cleanup step that ran after `ALL PASS` had already printed failed silently, leaving a probe row in production. See the assert-your-teardown rule above.

**The pattern in both: the assertions encoded what we thought to check, and the discrepancy was in what we happened to print.** Green means "the things I thought of are fine", never "everything is fine".

So: read counts, names, and scopes in a passing run, and treat any number that contradicts your model of the system as a defect until explained. Where a check surfaces a real state you did not anticipate, fix the *assertion* rather than the data — the `tls-t` case above failed a cutover-era assertion that had become wrong, and the right response was to retire the obsolete invariant, not to null out the row.

## STOP intake is NEVER gated on a sending flag

Receiving an opt-out does not depend on being able to send. A provider that is switched off, paused by a circuit breaker, or not yet live for API sending must still have its inbound STOPs ingested — **more** urgently, if anything, because a provider gets switched off precisely when something is wrong.

This was a real defect, not a hypothetical. `selectPollableCredentials` in `lib/sends/poll-opt-outs.ts` carried `AND p.supports_api_send = true`, and the provider page exposes that flag as a one-click **Disable**. Pressing it silently stopped TextHub opt-out ingestion — and TextHub's push callback is broken on their side, so that poller is its **only** intake. The failure is silent in the worst way: nothing errors, the poller just selects zero credentials and reports a healthy run, while the org keeps messaging people who asked it to stop.

**The rule: no intake path — poller, webhook, reconciliation backstop — may reference `supports_api_send`, `send_paused`, `sends_enabled`, `sends_paused`, or any future sending posture flag in its credential/row selection.** Provider *type* is fine (a TextHub poller should select TextHub credentials); provider *sending posture* is not.

Pinned by `scripts/test-stop-intake-ungated.ts`, which flips every sending flag off inside a rolled-back transaction and asserts each intake selection returns an identical, non-empty set — plus a source-level check that no sending predicate has reappeared, so a future edit fails even when the data happens to make the sets match.

## `adapter_code` is the connection TYPE; `sms_provider_id` is the row IDENTITY

Migration 0134 split these apart. Before it, one column was both, and because it is `UNIQUE` a second TextHub account could not reuse `txh` — it became its own row under the invented code `txh2`, which the adapter registry then special-cased back to the TextHub adapter.

**Which column to read depends on the question you are asking:**

| Question | Column |
|---|---|
| *What kind of provider is this? Which adapter serves it?* | `adapter_code` |
| *Which provider row / account is this?* | `sms_provider_id` (or `id`) |

Type-meaning reads — `getAdapter()` in the drain, the kickoff provider gate, the TextHub-family filter in the opt-out poller — all take `adapter_code`. Identity-meaning reads **must stay** on the row: circuit breakers, send windows, per-provider reporting and cost attribution are all per-ACCOUNT, and pointing them at `adapter_code` would silently merge two accounts' counters into one.

`NULL` means "no API adapter" and is a real state, not missing data (`snx`, `smpl` are sent manually). The drain's `getAdapter(provider_key ?? "")` throws `UnknownProviderError` for `NULL` exactly as it did for an unregistered code, and the same `unknown_provider` refusal catches it — so the switch was a no-op for those rows.

**The cutover was staged in three deploys on purpose**, and the shape is worth reusing for any column that something on the send path resolves against: (1) migration + backfill, with nothing reading the new column; (2) a gate proving the new column resolves to the *object-identical* adapter as the old one for every row, then switch the readers; (3) only after that is verified in production, delete the compatibility alias. Collapsing these into one deploy means a backfill error and a code change land together, with no step at which the old and new answers can be compared.

## A credential check has THREE outcomes, and "unknown" must never collapse into "pass"

`descriptor.validateCredentials` returns `valid` / `invalid` / **`unknown`** (`ValidateCredentialsResult`, `lib/sends/providers/types.ts`). The third state is not decoration and callers may not fold it into either of the other two.

The reason is that two of our providers — Ahoi/api19 and Tells — answer **HTTP 200 for authentication failures** and signal the real outcome only in the response body. A checker for those providers is therefore a *parser of an undocumented envelope*, and the envelope can change without notice. When it does, the classifier stops recognizing the failure shape. The only safe degradation is "we could not verify"; treating an unrecognized response as success turns a broken key into a green check, and the operator learns the truth when a campaign sends nothing.

So: an unrecognized body, a non-2xx that isn't an auth rejection, a timeout, an unreachable host — all `unknown`. Only a positively-recognized success shape is `valid`, and only a positively-recognized rejection is `invalid`. `validateCredentials` must also never throw; a network error is a returned `unknown`, not an exception.

The UI renders `unknown` as its own state ("Couldn't verify — provider response unrecognized"), visually distinct from both pass and fail.

The related honesty rule: **a connection type with no non-sending way to prove a key gets no `validateCredentials` at all** (`can_validate: false`), and the UI says so. Tells is the current case — its only endpoint sends a message, and it validates `from` before `key`, so even a crafted non-sending request never reaches key validation. Offering a "test" that cannot fail is worse than offering none.

## A provider's own webhook payload can carry a live credential — redact before persist

Tells's **inbound** webhook body includes a `Key` field, and Phase 0 established it is the **full live API key**, not a per-webhook secret. Capturing bodies verbatim — which every other provider's intake does, correctly — would have written a live sending credential into `tells_webhook_events.raw_body`, and from there into every database backup and any future export. That is CLAUDE.md §11 ("never log secrets") broken by a rule that is otherwise right.

The rule for any provider whose payload carries a secret: **capture stays byte-for-byte verbatim EXCEPT that field**, whose value is replaced with a fixed marker before the row is persisted (`redactTellsKeyFromBody`, `lib/sends/tells-webhook-shared.ts`). Surgical — one field, nothing else touched. Three details that make it hold:

- **Case-insensitive.** A casing change on their side must not silently reintroduce the credential.
- **Fails closed.** If the body doesn't parse we cannot *prove* the key isn't in it, so `null` is stored rather than the bytes. Losing an unparseable body is strictly better than persisting a live key — the extracted columns and the alert still carry the event.
- **Alerts are redacted too.** The unresolved-token alert path re-uses the same redaction; a Telegram message is not a place to paste an API key either.

Note this is orthogonal to whether the key is *rotated*. Rotation was declined for Tells because the exposure in ephemeral runtime logs was judged acceptable; a live credential replicated into every backup is a different and larger exposure, and the carve-out stands regardless.

## The send window is enforced in TWO places, and a degenerate window means "default", not "closed"

Quiet hours (`sms_providers.send_window_*`, minute-of-day in ET) are enforced at two layers, because one was never enough:

1. **`lib/sends/scheduled.ts`** — the `*/5` auto-send cron, per stage per tick, before handing off to the drain (`decideScheduledSend` on first fire, `isOutsideSendWindow` on resume).
2. **`runStageDrain`'s batch loop** — re-checked before **every** batch, alongside the `SEND_ENABLED` re-check. Stops a slice from spilling past the close mid-run, and because the gate block runs before the first batch it also covers callers that never went through the scheduler.

Plus a legibility check in the **manual per-stage drain route**, which refuses with `409 outside_send_window` so an operator gets a real error instead of a silent "0 sent" (`isStageOutsideSendWindow`, `lib/sends/send-window.ts`).

**Why two layers:** before 2026-08-13 the window was consulted *only* in (1), which meant a manual drain sent at any hour and a slice starting at 19:29 ran past the 19:30 close. Providers do not police this — Tells confirmed it accepts sends at any time — so the window is entirely ours to enforce.

`outside_send_window` is a **SOFT** `DrainStopReason`: rows stay `pending`, nothing is latched, and the next in-window tick resumes them. Nothing failed; we simply must not send at that hour.

### ⚠️ A degenerate window falls back to the DEFAULT, not to "closed"

`effectiveWindow` (`lib/quiet-hours.ts`) accepts a window only when `start != null && end != null && start < end`. Anything else — nulls, `start == end`, `start > end` — silently yields the **default 08:00–21:00 ET** window.

So **there is no way to express "never send" in these columns**, and setting `0/0` to disable a provider does the opposite of what it looks like. **Use `send_paused` to stop a provider sending** — the audited latch, not the window.

**Rejected at validation since 2026-08-13.** `checkSendWindows` in [lib/validators/providers.ts](../lib/validators/providers.ts) refuses any pair where both bounds are set and `start >= end`, on BOTH create and update, with a message pointing at pausing. A null pair still passes — that legitimately means "use the default". The refinement is applied to a shared base object rather than to `providerCreateSchema` directly, because attaching it there would turn it into a `ZodEffects` and break the `.partial()` the update schema is built from. This bit the first draft of the quiet-hours test in `scripts/verify-drain.ts`, which passed vacuously at midday because `0/0` had fallen back to the default and midday is inside it. That test now computes a valid band excluding the current minute from the DB clock, so it holds at any hour — worth copying if you ever test window behaviour.

## Go-live gates never live on a bulk settings form

**A field that decides whether something goes live must not be editable through a whole-object form.** `supports_api_send` was, and it silently re-enabled itself on the `tls` provider (2026-08-13, ClickUp 869ehjwtf). Four ordinary things composed into it:

1. The provider edit dialog rendered the flag as a Switch.
2. Save submits the **whole object**, not a dirty-field diff.
3. The PATCH applies every key present, with **no optimistic-concurrency check** (no version / etag / `updated_at` comparison).
4. react-hook-form captures `defaultValues` at **mount**, and the dialog keys on `provider.id` only — so the instance holds whatever value the page loaded with, for the page's whole lifetime.

Net: any save on that dialog — even one that only renames the provider — writes back the flag as it was when the page loaded. **A lost update on a gate that fails OPEN.** `send_paused` had already been carved out of that same form for this reason; the rule is now general:

- Such a flag gets its **own endpoint**, its own Zod schema, and an **audit row naming the actor** (`send_circuit_events`, migration 0131 for the api-send verbs).
- It is **stripped from the create/update schemas entirely**, so the bulk PATCH cannot carry it even if a client sends it. New rows start with the gate OFF; turning it on is a deliberate, attributable act.
- The bulk form may still *read* the value for display/layout (`ProviderForm`'s `supportsApiSend` prop) — it just cannot write it.

Also worth knowing: this was undiagnosable from stored data because `sms_providers` has **no `updated_at`** and nothing audited the column. When a field matters enough to gate sending, it matters enough to audit.

## ⚠️ Zod: `.partial()` does NOT strip an inner `.default()`

`providerUpdateSchema = providerCreateSchema.partial()` over a field declared `z.boolean().optional().default(false)` parses an **omitted** key to `false` — a real value, not `undefined`. So a route that skips undefined (`if (v === undefined) continue`) still **writes** it, and any partial PATCH silently cleared the flag. Verified against the Zod version in this repo, not assumed.

Fix: re-declare the field on the update schema without the default (`.extend({ short_link_supported: z.boolean().optional() })`), so "omitted" means "leave unchanged" while an **explicit** `false` is still written — those are different intents and must not collapse. Pinned by [scripts/test-provider-update-schema.ts](../scripts/test-provider-update-schema.ts), which asserts on what the route would actually SET (it reproduces the route's update-building loop), not merely on what Zod returns. **A `.default()` is right for a create schema and wrong for an update schema** — check any other `X.partial()` you build from a defaulted create schema.

## Migration ordering — additive leads the code, destructive follows it

[CLAUDE.md §14](../CLAUDE.md) says to apply migrations **before** pushing the code that depends on them. That is correct for **additive** changes (a new table or column): the code needs the schema to exist, and an unused new column harms nothing while it waits.

**It inverts for destructive changes.** Dropping a column or table while deployed code still writes to it breaks that code the instant the migration lands. The order is:

1. Remove the dependent code
2. Merge and deploy it
3. **Confirm the affected job has run clean against production** — a deploy proves the code shipped, not that the write path is actually gone
4. Then apply the destructive migration, as a separate step

Applied when `keitaro_stage_results.epc` was dropped (2026-08-11): the write was removed from [`lib/keitaro/poll.ts`](../lib/keitaro/poll.ts) and deployed first, a full poll cycle was confirmed, and only then was the column dropped. Snapshot the data first — a drop is unrecoverable and an export costs nothing (`docs/snapshots/`).

## Verifying a surface means ROUND-TRIP, not render

A UI or API change is verified when a value **posted through the real route comes
back from a fresh read**. Neither of the two cheaper checks is evidence:

- **That the component renders** proves the code is reachable. It says nothing
  about whether the value it produces is stored. (The earlier trap — a control
  put in dead render code — is the reachability half of the same lesson, and
  passing it does not discharge this one.)
- **The POST response body** is built from the same in-memory object the insert
  was built from, so it happily echoes a field that was never written.

This is not hypothetical. Drip stage windows shipped uncreatable: the validator
accepted `window_start_min` / `window_end_min` / `drip_active`, the multi-row
guard checked them, and the route answered **201** — while Drizzle's `.values()`
literal, which writes exactly the keys it is handed, omitted all three. Postgres
was never asked to store them and so had nothing to reject. The scheduler selects
`WHERE drip_active IS TRUE`, so no stage created through the product was ever
visible to it. A DB-level test would have passed against the broken route,
because the database was never the broken part.

**Consequences:**

1. Any route that writes through an explicit column literal needs a test that
   POSTs and then GETs. See
   [scripts/test-stage-post-roundtrip.ts](../scripts/test-stage-post-roundtrip.ts).
2. When adding a field, grep for every write literal in the route — the validator
   and the guard are not the write. `PATCH` and `POST` are separate literals and
   have already diverged once: PATCH persisted the windows while POST dropped
   them, so the feature appeared to work for anyone who edited a stage twice.
3. A guard whose input can never be populated is **vacuously green**. The window
   overlap/touch check could not fire, because no sibling ever stored a window.

## A campaign type that cannot satisfy the launch gate cannot launch

`campaigns.type = 'drip'` is exempt from the contact-group requirement in **both**
the create validator and the `draft → active` status route, and a drip activation
skips `snapshotAudience` entirely (its frozen count is `0`, which is correct —
the audience arrives later as leads, and `campaign_audience_pool` stays empty for
that campaign forever).

Without the exemption the type was uncreatable in its launched form and could
never reach `active` — which routing, the scheduler **and** the drain all require.
It was shipped and merged in that state because every test either synthesized
rows directly or asserted that *regular* campaigns were unaffected. Nothing tried
to drive the new type through the product.

**The exemption is a positive read, never an inverse** (R13): only `type === 'drip'`
skips. NULL, absent, or a future value keeps today's requirement, so a campaign
this build cannot classify can never activate with no audience.

## Drip's "human approved this send" is three deliberate acts, not a button

A regular stage sends because a person pressed approve (`send_approved`). A drip
stage has no such moment — leads arrive unattended — so the scheduler stamps
`send_approved` / `materialized_at` / `sent_at` itself, in the same transaction
as the first `stage_sends` insert. The approval it stands in for is the three
things a human had to do first: set `drip_active` on the stage, turn on org
posture, and move the campaign to `active`.

`AND drip_active IS TRUE` in that statement's `WHERE` is what keeps the bargain —
it can never approve a regular stage, whatever goes wrong upstream.

⚠️ **`sent_at` is filled with `COALESCE`, never assigned.** That column has two
other writers (the "Mark as sent" status action, and the scheduled-send path which
uses it as a fire-lock — stamping it out from under that path once silently
cancelled a scheduled send). Filling only a NULL means whichever writer arrives
first wins and neither can erase the other. The statement also carries a trailing
predicate so a second pass is a true no-op rather than a same-value rewrite.

## A drip send mints its own link, per lead, and fails closed without one

The drip scheduler mints one tracked link per lead inside the SAME transaction as
the `stage_sends` insert, then renders the body around it. It cannot read a link
off the stage: `campaign_stages.short_url` is a static column and is NULL on
every drip stage, which is exactly how drip shipped sending copy that ends in a
colon and then stops, with `link_id` NULL — no `/r/` redirect, no click, no
Keitaro attribution, and an unattributable send that was still paid for.

**If any component cannot be resolved — landing page, brand `landing_host`, short
domain, either tracking ID — the lead is SKIPPED with a logged reason and no
send.** Its journey stays `routed`, so fixing the configuration lets the next
tick pick it up unchanged. This mirrors the opt-out gate: a message that cannot
be built correctly is not a message to send approximately.

Nothing in [lib/drip/mint.ts](../lib/drip/mint.ts) is a second copy of a rule —
destination construction is `buildLandingPageUrl` (shared with the stage editor's
preview) and short-domain precedence is `resolveShortDomainForSend` (shared with
kickoff and the verifier). Two copies of a URL rule means drip and blast sending
different links from the same configuration.

⚠️ **A test that asserts "a link exists" tests almost nothing** — a link to the
wrong destination passes it. Resolve the minted code through `link_destinations`
and compare the URL.

## ⚠️ A /lp/ URL must LEAD with sub_id3; extra params are allowed since 0170

The CHECK requires the first parameter to be `sub_id3=<[A-Za-z0-9_]+>` and then
permits `&key=value` pairs. `validateBrandLpShape` (app) mirrors it exactly, and
`GUIDEKN_DEST_RE` was widened in step so the rule does not differ per brand.

⚠️ **When one side changes, change both.** The app being LOOSER than the
constraint is the dangerous direction and is what produced this work: a lumzen
/lp/ URL with a UTM param passed every app check and was rejected by the database
at MINT, surfacing hours later as skipped leads rather than at Save.

## ⚠️ `link_destinations_landing_url_shape` hardcodes the brand landing hosts

The 0094 CHECK is:

```
url NOT LIKE '%/lp/%'
  OR url ~ '^https://(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$'
```

The host list is **literal**. A new brand with its own `landing_host` and a
`kind='slug'` landing page will mint fine right up to the `link_destinations`
insert and then fail on the constraint — for drip that surfaces as every lead
being skipped with `invalid_destination`, for a blast as a failed
materialization. Adding a brand landing host means editing this constraint in the
same change. (It is `NOT VALID` by design — see the guidekn URL-shape note — so
altering it does not force a full table scan.)

## A scripted patch can write a control character that every review surface hides

A patch that produced a regex meant to read `/STOP/i` instead wrote two
literal **BACKSPACE** bytes (0x08) where the escapes belonged. The result:

- `tsc` clean, ESLint clean.
- The line renders correctly in an editor, in `sed`, in `grep`, and in the GitHub
  diff — a terminal draws 0x08 as nothing at all.
- The regex could never match, so the drip opt-out gate refused **every** txr
  lead. It failed CLOSED, so nothing wrong was sent; nothing at all was sent
  either, and the only symptom was a counter reading `gateRefused: 1`.

It shipped, deployed, and was only caught because the send that should have
followed never appeared.

**Two guards, because either alone is weak:**

1. **Behaviour.** Predicates like this belong in an exported function with a test
   that runs them on real text, not inline in a worker where nothing can reach
   them. `bodyCarriesStop` in [lib/sends/opt-out-footer.ts](../lib/sends/opt-out-footer.ts).
2. **Bytes.** [scripts/test-stop-keyword-guard.ts](../scripts/test-stop-keyword-guard.ts)
   scans every `.ts`/`.tsx` file for C0 control characters (tab/newline/CR
   excepted). This is the only check that sees the class at all.

**When scripting an edit that contains regex escapes, verify the result with
`od -c` or `cat -v`, not by reading it back.** Reading it back is exactly the
check this class defeats. Building the bytes explicitly (`chr(92) + "b"`) is
safer than relying on nested escaping through a shell heredoc into a language
literal.

## `next build` passing does not mean `next dev` runs

`app/api/offers/[id]` and `app/api/offers/[offerId]` coexisted on main: two
different slug names for one dynamic path. **The production build tolerated it
and deployed green, while `next dev` refused to boot with
`You cannot use different slug names for the same dynamic path`.** So CI, the
deploy and the live site were all healthy and the app simply could not be run
locally — a failure that looks like "my machine is broken" rather than a repo
defect, and that nothing in the pipeline reports.

Per §8, API routes nesting children under a dynamic parent use
`[parentEntityId]`. The dynamic segment's NAME is internal — `/api/offers/123/archive`
is unchanged by the rename — so fixing this is a param-key edit, not an API change.

**If the dev server will not start, check for sibling dynamic segments before
assuming a local problem.**

## The campaign editor's live component is `campaign-editor-page.tsx`

`components/campaigns/campaign-form.tsx` and `campaign-form-fields.tsx` are DEAD
render code: `/campaigns/new` and `/campaigns/[id]/edit` both render
`CampaignEditorPage`, which imports only `CarrierRemovedLines` from the fields
file and lays out its own `SetupCard` / `AudienceCard` / `AudienceCompositionPanel`.
Editing the form-fields file changes nothing an operator can see.

⚠️ This has now caught work twice. Trace page → component before editing, and
confirm with a round-trip in the browser, not by finding a plausible-looking file.

## A drip journey has terminal states, and closing one frees a slot

`drip_journeys.state` is `routed | active` (live) or `opted_out | converted |
completed | expired | exited | unroutable` (terminal). A terminal row MUST carry
`closed_at` and a live one must not - a CHECK enforces it, so "is this closed?"
cannot become two facts that disagree.

**Closing is not bookkeeping.** `drip_journeys_one_live_per_contact_uniq` keys on
`state IN ('routed','active')`, so a live journey holds that contact's ONLY drip
slot. Before Phase 6 nothing ever closed a journey, so every contact ever routed
held its slot for ever and an opted-out lead kept it too. Any terminal value
frees the slot by construction - which is why the vocabulary was widened rather
than the index rewritten.

Freeing the slot is **not** permission to re-route: the week rule, the
same-offer-same-creative rule and the org-wide opt-out gate all still apply.

`exited` is an **archive** trigger, never a delete one: `campaign_id` is
`ON DELETE CASCADE`, so a hard delete removes the journey rather than leaving one
to mark. That is accepted.

## Keitaro's `offer_reached_at` / `converted_at` are EVENT time, not detection time

Both pollers write `(v.dt || ' ' || CAMPAIGN_TIMEZONE)::timestamptz` - the
network's own timestamp. Postback lag is measured in hours: offer reach p50 **146
min**, conversion p50 **219 min** (30 days), plus up to 15 minutes of poll
cadence.

**So a "time since detection" timer cannot key off them.** At p50 a 60-minute
Offer follow-up computed from `offer_reached_at` is already expired the moment we
learn of it: the operator sets 60 minutes and the message fires instantly.
`offer_reached_detected_at` / `converted_detected_at` (0169) record when WE
learned, and are the only honest clock for such a timer.

The conversions poller stamps its detection column with `COALESCE(existing,
now())`, not a bare `now()` - unlike the offer-reach UPDATE it has no `IS NULL`
guard and re-writes rows whose status changed, so a bare assignment would slide
the detection time forward on every poll and keep a follow-up permanently in the
future.

Tier 1 needs no such column: `clicks.clicked_at` defaults to `now()` at the `/r/`
request, so a click's detection **is** its event.

## Open `[VERIFY]` items (could not confirm from source in this pass)
- Exact production `DATABASE_URL` pooler port (6543 expected) — discrepancy #3.
- The live DB's `segment_rules` CHECK contents — discrepancy #2.
- Per-route `runtime` / `dynamic` exports for cron + redirect handlers (Node runtime / force-dynamic expected).
- How `campaign_stages.status` / `sent_at` are reconciled after a TextHub drain (kickoff/drain operate only on `stage_sends`).
- Whether any protected page is reachable without a server-side membership check — discrepancy #5.
