# Offer Group Report — per-recipient attribution · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/offers/[id]/report` group rows show metrics for the contacts actually in each group, instead of replicating each campaign's whole economics into every group it targeted.

**Architecture:** Replace the `CROSS JOIN LATERAL unnest(group_ids)` fan-out in `offer_group_report_mv` with a per-recipient join (`stage_sends ⋈ contact_contact_groups`) that already runs today for the list-pressure columns. Add a third matview at offer grain so the footer has a source that survives an offer with zero group rows. The org benchmark and `offer_report_campaign_econ` are untouched.

**Tech Stack:** Postgres 17 (materialized views, hand-written SQL migrations) · Drizzle ORM · Next.js 16 App Router · TypeScript · tsx verification scripts.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-14-offer-group-report-attribution-design.md`. Read it before Task 2.
- **Worktree:** `C:/AFF/camman/.claude/worktrees/og-attrib`, branch `fix/offer-group-report-attribution`. **Never** run git or edit files in the shared `C:/AFF/camman` checkout — another session owns it and has uncommitted work. Use `git -C <worktree>` on every git call; the Bash tool's cwd is not sticky.
- **Migration number is 0132.** `0130_tells_webhook_events` and `0131_api_send_audit_events` are already on `origin/main`. Re-check `db/migrations/meta/_journal.json` before writing the file in case another branch landed first.
- **Migrations are hand-authored.** `npm run db:generate` blocks on a TTY prompt. Write the SQL, clone the snapshot forward, add the journal entry by hand.
- **Migration files must be LF** (enforced by `.gitattributes` `db/migrations/** eol=lf`) and use `--> statement-breakpoint` between statements.
- **`npm run db:migrate` targets the SHARED PRODUCTION database.** It is gated on Dmytro's explicit go-ahead (Task 8). Do not run it in Tasks 1–7.
- **No test runner exists** for this area. Verification is `npx tsx` scripts. `npm run lint` lints all 9 worktrees and exits 1 on other branches' problems — lint changed files only.
- Multi-tenancy: every query filters `org_id`. The matviews carry `org_id` and the read helper passes it.
- Money is `numeric(14,4)` in the matviews, displayed USD.

### Deviation from the spec, stated deliberately

The spec's §4.1 lists `unattributed_cost` on the totals matview. **This plan omits it.** Nothing displays it and no verification criterion uses it — criterion 3b bounds sends only. Adding an unused column costs a `COUNT(DISTINCT)`-scale aggregate on every refresh. If a cost breakdown is wanted later it is a one-column addition. Flag this to Dmytro; if he wants it, add it in Task 2 alongside `attributable_sends` using the same distinct-send basis.

---

### Task 1: Verification script (written first, must fail today)

The script is written before the migration so it can be run against the **current broken state** and demonstrate the defect. It detects whether the totals matview exists and reports pre- or post-migration accordingly, so the same file serves both runs.

**Files:**
- Create: `scripts/verify-offer-group-attribution.ts`

**Interfaces:**
- Consumes: nothing from other tasks. Reads `offer_group_report_mv`, `offer_report_org_summary_mv`, `offer_report_offer_totals_mv` (after Task 2), `offer_report_campaign_econ`, `stage_sends`, `contact_contact_groups`, `campaigns`.
- Produces: `npx tsx scripts/verify-offer-group-attribution.ts`, exit 0 on pass / 1 on fail. Tasks 2 and 8 run it.

- [ ] **Step 1: Write the verification script**

Create `scripts/verify-offer-group-attribution.ts`:

```ts
import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// =============================================================================
// OFFER GROUP REPORT — PER-RECIPIENT ATTRIBUTION VERIFICATION
//
// Every check recomputes BOTH sides in this run. Nothing is compared against a
// constant transcribed from the spec: production keeps sending and the matviews
// refresh twice daily, so the org benchmark moved 3,106,967 -> 3,135,015 and
// offer 96's sends 88,536 -> 93,176 in the 24h the spec took to write. A
// criterion pinned to those numbers measures the calendar, not the code.
//
// Run: npx tsx scripts/verify-offer-group-attribution.ts
// =============================================================================

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failed++; console.log(`  ✗ ${msg}`); }
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
  const d = drizzle(c);
  const q = async (x: ReturnType<typeof sql>) =>
    (await d.execute(x)) as unknown as Record<string, unknown>[];
  const n = (v: unknown) => Number(v ?? 0);

  // --- INPUT SCOPE, printed before any verdict. A check is not evidence until
  // you know what it ran against.
  const scope = (await q(sql`
    SELECT (SELECT count(*) FROM offer_group_report_mv)::int              AS mv_rows,
           (SELECT count(DISTINCT offer_id) FROM offer_group_report_mv)::int AS mv_offers,
           (SELECT count(*) FROM organizations)::int                      AS orgs,
           (SELECT refreshed_at FROM report_refresh_log
             WHERE view_name = 'offer_group_report_mv')                   AS refreshed_at
  `))[0];
  console.log("=== INPUT SCOPE ===");
  console.table([scope]);
  assert(n(scope.mv_rows) > 0, "offer_group_report_mv is non-empty (an empty scope is a failure, not a pass)");

  const hasTotals = n((await q(sql`
    SELECT count(*)::int AS n FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname = 'offer_report_offer_totals_mv'
  `))[0].n) > 0;

  if (!hasTotals) {
    // PRE-MIGRATION. Measure and print the defect, then fail deliberately.
    console.log("\n=== PRE-MIGRATION STATE (offer_report_offer_totals_mv absent) ===");
    const defect = await q(sql`
      SELECT m.offer_id,
             sum(m.sends)::bigint                          AS column_sum,
             (SELECT sum(e.sends) FROM offer_report_campaign_econ e
               WHERE e.offer_id = m.offer_id)::bigint      AS true_sends,
             count(*)::int                                 AS group_rows,
             count(DISTINCT m.sends)::int                  AS distinct_send_values
      FROM offer_group_report_mv m GROUP BY m.offer_id
      ORDER BY sum(m.sends) DESC LIMIT 5
    `);
    console.table(defect);
    console.log(
      "\nEach row's `distinct_send_values` well below `group_rows` is the fan-out:\n" +
      "one campaign's totals repeated across every group it targeted.",
    );
    console.log("\nEXPECTED FAIL — migration 0132 has not been applied.");
    await c.end();
    process.exit(1);
  }

  // ---------------------------------------------------------------- criterion 1
  // Offer 96: new `sends` == the row's own `sent_90d`, the same quantity by two
  // paths. Valid ONLY while all of the offer's sends fall inside 90 days —
  // asserted, not assumed.
  console.log("\n=== 1. offer 96: sends == sent_90d per row ===");
  const win = (await q(sql`
    SELECT min(ss.sent_at) AS oldest, now() - interval '90 days' AS floor
    FROM stage_sends ss JOIN campaigns ca ON ca.id = ss.campaign_id
    WHERE ca.offer_id = 96 AND ss.status = 'sent'
  `))[0];
  if (!win.oldest || new Date(String(win.oldest)) < new Date(String(win.floor))) {
    console.log(`  ~ SKIPPED: offer 96's oldest send (${win.oldest}) predates the 90d floor ` +
                `(${win.floor}); the two columns are no longer the same quantity.`);
  } else {
    const rows = await q(sql`
      SELECT group_id, sends, sent_90d FROM offer_group_report_mv WHERE offer_id = 96
    `);
    assert(rows.length > 0, `offer 96 has group rows (${rows.length})`);
    for (const r of rows) {
      assert(n(r.sends) === n(r.sent_90d),
        `group ${r.group_id}: sends ${r.sends} == sent_90d ${r.sent_90d}`);
    }
  }

  // ---------------------------------------------------------------- criterion 2
  // The column exceeds the footer by the multi-group overlap factor. Both sides
  // read here; the RATIO is the stable observable, not the absolutes.
  console.log("\n=== 2. offer 96: column sum vs footer ===");
  const agg = (await q(sql`
    SELECT (SELECT sum(sends)   FROM offer_group_report_mv WHERE offer_id = 96)::bigint AS col_sends,
           (SELECT sum(revenue) FROM offer_group_report_mv WHERE offer_id = 96)         AS col_rev,
           (SELECT sends   FROM offer_report_offer_totals_mv WHERE offer_id = 96)::bigint AS foot_sends,
           (SELECT revenue FROM offer_report_offer_totals_mv WHERE offer_id = 96)         AS foot_rev,
           (SELECT sum(e.sends) FROM offer_report_campaign_econ e WHERE e.offer_id = 96)::bigint AS econ_sends
  `))[0];
  const ratio = n(agg.col_sends) / Math.max(n(agg.foot_sends), 1);
  console.log(`  column ${agg.col_sends} / footer ${agg.foot_sends} = ${ratio.toFixed(3)}x ` +
              `(revenue ${agg.col_rev} / ${agg.foot_rev})`);
  assert(n(agg.foot_sends) === n(agg.econ_sends),
    `footer ${agg.foot_sends} == campaign-grain econ ${agg.econ_sends}`);
  assert(ratio > 1, `column exceeds footer (a multi-group campaign exists): ${ratio.toFixed(3)}x`);
  assert(ratio < 3,
    `overlap factor is plausible (<3x); ~10x means the unnest fan-out survived — got ${ratio.toFixed(3)}x`);

  // --------------------------------------------------------------- criterion 3a
  // Σ footer over every offer == benchmark sends. Catches campaigns leaking out
  // of the offer partition and dropped/duplicated offer rows. Offer count comes
  // from the data, never a hardcoded 21.
  console.log("\n=== 3a. Σ footer == benchmark (offer partition is complete) ===");
  const part = (await q(sql`
    SELECT (SELECT count(*) FROM offer_report_offer_totals_mv)::int      AS offers,
           (SELECT sum(sends) FROM offer_report_offer_totals_mv)::bigint AS footer_sum,
           (SELECT sum(sends) FROM offer_report_org_summary_mv)::bigint  AS benchmark,
           (SELECT COALESCE(sum(e.sends), 0) FROM offer_report_campaign_econ e
             WHERE e.offer_id IS NULL)::bigint                           AS null_offer_sends
  `))[0];
  console.table([part]);
  assert(n(part.offers) > 0, `totals matview covers ${part.offers} offers (asserted from data)`);
  assert(
    n(part.footer_sum) + n(part.null_offer_sends) === n(part.benchmark),
    `Σ footer ${part.footer_sum} + NULL-offer ${part.null_offer_sends} == benchmark ${part.benchmark}`,
  );
  if (n(part.null_offer_sends) > 0) {
    console.log(`  ! ${part.null_offer_sends} sends belong to campaigns with a NULL offer_id — ` +
                `expected 0; they are outside every offer's report by design, but the ` +
                `non-zero value is printed so this never fails silently.`);
  }

  // --------------------------------------------------------------- criterion 3b
  // Residual bound. Negative == scope mismatch between the totals matview and the
  // attribution CTE: group rows claiming sends the footer never counted.
  console.log("\n=== 3b. 0 <= unattributed <= sends, per offer ===");
  const resid = await q(sql`
    SELECT offer_id, sends, attributable_sends, unattributed_sends
    FROM offer_report_offer_totals_mv
    WHERE unattributed_sends < 0 OR unattributed_sends > sends
  `);
  console.table(await q(sql`
    SELECT offer_id, sends, attributable_sends, unattributed_sends,
           round(100.0 * unattributed_sends / NULLIF(sends, 0), 2) AS pct_unattributed
    FROM offer_report_offer_totals_mv ORDER BY unattributed_sends DESC LIMIT 8
  `));
  assert(resid.length === 0,
    `no offer has a residual outside [0, sends] (${resid.length} violations)`);

  // ----------------------------------------------------------------- criterion 5
  console.log("\n=== 5. group rows carry no manual-mix flag ===");
  const cols = await q(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'offer_group_report_mv'
      AND column_name IN ('has_manual_stages', 'offer_clicks', 'offer_has_manual')
  `);
  assert(cols.length === 0,
    `offer_group_report_mv has none of has_manual_stages/offer_clicks/offer_has_manual ` +
    `(found: ${cols.map((r) => r.column_name).join(", ") || "none"})`);
  assert(
    n((await q(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='offer_report_offer_totals_mv'
        AND column_name='has_manual_stages'`))[0].n) === 1,
    "has_manual_stages moved to the offer-totals matview",
  );

  // ----------------------------------------------------------------- criterion 6
  // Every offer is in exactly one of two states: has group rows, or has none and
  // a non-zero footer. Neither == a dropped row. Derived from data, not the id
  // list that held on 2026-08-14.
  console.log("\n=== 6. every offer has rows XOR is fully external ===");
  const states = await q(sql`
    SELECT t.offer_id, t.sends, t.attributable_sends,
           (SELECT count(*) FROM offer_group_report_mv m
             WHERE m.org_id = t.org_id AND m.offer_id = t.offer_id)::int AS group_rows
    FROM offer_report_offer_totals_mv t
  `);
  const external = states.filter((s) => n(s.group_rows) === 0);
  const withRows = states.filter((s) => n(s.group_rows) > 0);
  console.log(`  ${withRows.length} offers with group rows, ${external.length} fully external`);
  for (const s of external) {
    assert(n(s.attributable_sends) === 0,
      `offer ${s.offer_id}: no group rows AND attributable_sends is 0 (sends ${s.sends})`);
  }
  for (const s of withRows) {
    assert(n(s.attributable_sends) > 0,
      `offer ${s.offer_id}: has ${s.group_rows} group rows AND attributable_sends > 0`);
  }

  console.log(failed === 0 ? "\nverify-offer-group-attribution OK." : `\n${failed} FAILED.`);
  await c.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it against the current state to verify it fails**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/verify-offer-group-attribution.ts
```

Expected: prints INPUT SCOPE, then `PRE-MIGRATION STATE`, a table where `distinct_send_values` is far below `group_rows` per offer (offer 96 showed 12 group rows / 3 distinct values), then `EXPECTED FAIL — migration 0132 has not been applied.` and **exit code 1**.

If it exits 0, the totals matview already exists — stop and find out who created it.

- [ ] **Step 3: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add scripts/verify-offer-group-attribution.ts
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "test(reports): verification for offer-group per-recipient attribution

Fails today by design: measures the unnest fan-out and reports the
pre-migration state. Every check recomputes both sides in-run -- no
constants transcribed from the spec, because the benchmark and offer 96's
sends both moved while the spec was being written."
```

---

### Task 2: Migration 0132 — rebuild the matviews

**Files:**
- Create: `db/migrations/0132_offer_report_per_recipient_attribution.sql`
- Create: `db/migrations/meta/0132_snapshot.json` (clone of `0131_snapshot.json`, two ids changed)
- Modify: `db/migrations/meta/_journal.json` (append one entry)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `offer_report_tracked_campaigns` (plain view) `(id int, org_id uuid, offer_id int, gids int[])` — the attribution universe, defined once and selected by both matviews.
  - `offer_report_offer_totals_mv (org_id uuid, offer_id int, sends bigint, revenue numeric(14,4), sales bigint, clicks bigint, cost numeric(14,4), optouts bigint, has_manual_stages bool, attributable_sends bigint, attributable_revenue numeric(14,4), attributable_sales bigint, unattributed_sends bigint)`
  - a rebuilt `offer_group_report_mv (org_id, offer_id, group_id, group_name, sends, revenue, sales, clicks, cost, optouts, sent_7d, sent_30d, sent_90d, fresh_pool)`
  - Tasks 3–5 read these names.

- [ ] **Step 1: Write the migration SQL**

Create `db/migrations/0132_offer_report_per_recipient_attribution.sql` (**LF line endings**):

```sql
-- Migration 0132: attribute the offer group report PER RECIPIENT.
--
-- 0128 fixed HOW the clicker count was aggregated. It did not fix WHO a row is
-- about. `offer_group_report_mv` builds its economics with
-- `CROSS JOIN LATERAL unnest(group_ids)`, so a campaign that targeted 12 groups
-- contributes its ENTIRE sends/revenue/sales/cost/optouts to all 12 rows. And
-- 0128's own `cell_tracked` deduplicated clickers within a cell but never
-- required the clicker to be a MEMBER of the group -- so the EPC denominator is
-- replicated alongside its numerator.
--
-- Measured on offer 96 (Kinzeno 15013 Roller), 2026-08-13: 4 campaigns, 88,536
-- real sends, twelve group rows of which seven were byte-identical at 78,765
-- sends / 24 sales / $991.38. The footer summed those rows and read 904,926 --
-- 10.2x the truth. Five of twelve rows flip from above break-even to below once
-- attribution is real, and AstroEnergy goes from +$696 profit to -$74.
--
-- THE RULE: a group row counts the sends that actually reached contacts in that
-- group -- `stage_sends` joined to `contact_contact_groups` on the recipient,
-- restricted to groups the campaign targeted. Full count, not a fractional
-- share: the ratios then answer "of the messages sent to Memory members, what
-- did those recipients return", which is the question the screen exists for.
-- The price is that the columns DO NOT FOOT -- a contact in three of an offer's
-- groups is one send and three group-sends (+18.7% on sends, +37.5% on revenue
-- for offer 96). That is what non-additivity looks like on screen, and it is the
-- same rule 0128 applied to clicks, now applied to six columns.
--
-- COST cannot be read per recipient: `stage_sends.cost_per_sms` is NULL on
-- 967,276 of 2,954,929 sent rows (32.7%), covering only $19,879 of $32,440. It
-- is derived from the stage instead: `total_cost / (sent rows of that stage)`.
--
-- SCOPE FILTERS MIRROR `offer_report_campaign_econ` PER COLUMN, because that
-- view is not internally consistent:
--   tracked sends (`ts`)  -- status='sent', NO stage-level sent_at/archived_at
--   manual sends / cost   -- sent_at IS NOT NULL AND archived_at IS NULL
--   sends column          -- CASE WHEN link_mode='tracked' THEN ts ELSE mc END
-- So `attr` carries no stage-level filter (mirrors ts) while `rate` filters
-- sent_at/archived_at (mirrors cst), and `camp` is restricted to
-- link_mode='tracked'. That last one is load-bearing: campaign 110 has
-- sms_count=0 across its stages but 889 real stage_sends rows, so counting it
-- would put 889 sends in group rows that the footer never counted -- a
-- campaign-grain residual of -889, masked only because offer 58 is large enough
-- to absorb it. Restricting to tracked takes the minimum residual to exactly 0.
--
-- MANUAL-MODE CLICK FALLBACK IS GONE FROM GROUP ROWS, provably: of 938 sent
-- stages, 22 have per-recipient sends but no counted_clickers, and all 22 have
-- ZERO Keitaro visits. Every one of the 1,884 fallback visits sits on the 59
-- externally-sent stages, i.e. the same bucket as the un-attributable sends. So
-- `has_manual_stages` can never be true at group grain; it moves to the offer
-- totals. 33 of 80 cells carried that mixed-unit flag before this.
--
-- ~4.9% of sends (152,929 of 3,135,015 on this basis) cannot reach any group
-- row -- sends performed entirely outside the app with a hand-recorded
-- sms_count. 6 of 21 offers are 100% external and now render NO group rows.
-- `offer_report_offer_totals_mv` exists per offer regardless, so the footer and
-- the "recorded outside the app" note still render for them.
--
-- `offer_report_campaign_econ` and `offer_report_org_summary_mv` are UNCHANGED:
-- the benchmark was already campaign-grain and correct. Note the bias direction
-- is the opposite of the EPC workstream -- there the benchmark was the inflated
-- half; here it is the only correct one.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP VIEW IF EXISTS public.offer_report_tracked_campaigns;
--> statement-breakpoint
-- The attribution universe, defined ONCE. Both matviews below select from this
-- rather than each carrying its own copy: if the two ever diverged,
-- `attributable_sends` and the group rows would be computed over different
-- campaign sets and the residual `sends - attributable_sends` could go negative
-- while every individual query still looked correct. That scope mismatch is
-- precisely the failure this migration exists to prevent, so it is made
-- structurally impossible instead of guarded by a comment. Postgres inlines a
-- plain view like this one, so there is no planning or execution cost.
CREATE VIEW public.offer_report_tracked_campaigns AS
  SELECT c.id, c.org_id, c.offer_id, c.audience_contact_group_ids AS gids
  FROM public.campaigns c
  WHERE c.offer_id IS NOT NULL
    AND c.link_mode = 'tracked'
    AND EXISTS (SELECT 1 FROM public.campaign_stages s
                WHERE s.campaign_id = c.id AND s.sent_at IS NOT NULL);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_report_offer_totals_mv AS
WITH base AS (
  SELECT e.org_id, e.offer_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts,
    bool_or(e.has_manual_stages)  AS has_manual_stages
  FROM public.offer_report_campaign_econ e
  WHERE e.offer_id IS NOT NULL
  GROUP BY e.org_id, e.offer_id
),
-- DISTINCT sends, not the sum of the group cells: that sum is non-additive by
-- design and using it here would reintroduce the defect this migration removes.
attributable AS (
  SELECT camp.org_id, camp.offer_id, COUNT(DISTINCT ss.id)::bigint AS n
  FROM public.stage_sends ss
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id
),
-- Offer-grain clicks: DISTINCT contacts, plus manual-stage visits which have no
-- set behind them to deduplicate. Same decomposition 0128 established.
offer_tracked AS (
  SELECT c.org_id, c.offer_id, COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.campaigns c ON c.id = cc.campaign_id
  WHERE c.offer_id IS NOT NULL
  GROUP BY c.org_id, c.offer_id
),
offer_manual AS (
  SELECT c.org_id, c.offer_id, SUM(COALESCE(k.visits, 0))::bigint AS n
  FROM public.campaign_stages cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id)
  GROUP BY c.org_id, c.offer_id
)
SELECT b.org_id, b.offer_id, b.sends, b.revenue, b.sales,
  (COALESCE(ot.n, 0) + COALESCE(om.n, 0))::bigint AS clicks,
  b.cost, b.optouts, b.has_manual_stages,
  COALESCE(a.n, 0)::bigint                      AS attributable_sends,
  (b.sends - COALESCE(a.n, 0))::bigint          AS unattributed_sends
FROM base b
LEFT JOIN attributable  a  ON a.org_id  = b.org_id AND a.offer_id  = b.offer_id
LEFT JOIN offer_tracked ot ON ot.org_id = b.org_id AND ot.offer_id = b.offer_id
LEFT JOIN offer_manual  om ON om.org_id = b.org_id AND om.offer_id = b.offer_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_offer_totals_mv_key_uniq
  ON public.offer_report_offer_totals_mv (org_id, offer_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
-- Effective per-send cost from the STAGE. stage_sends.cost_per_sms is NULL on
-- 32.7% of sent rows and would silently under-count older campaigns.
WITH rate AS (
  SELECT cs.id AS stage_id,
         cs.total_cost / NULLIF(COUNT(ss.id), 0) AS per_send
  FROM public.campaign_stages cs
  LEFT JOIN public.stage_sends ss ON ss.stage_id = cs.id AND ss.status = 'sent'
  WHERE cs.sent_at IS NOT NULL AND cs.archived_at IS NULL
  GROUP BY cs.id, cs.total_cost
),
-- ONE pass over the stage_sends x contact_contact_groups join: economics AND
-- list pressure. That join already ran for the list-pressure columns alone, so
-- the economics ride along at ~zero marginal cost (9.53s -> 9.96s measured).
attr AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*)::bigint                                        AS sends,
    SUM(COALESCE(r.per_send, 0))::numeric(14,4)             AS cost,
    SUM(COALESCE(ss.sale_revenue, 0))::numeric(14,4)        AS revenue,
    COUNT(*) FILTER (WHERE ss.converted_at IS NOT NULL)::bigint AS sales,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d
  FROM public.stage_sends ss
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  LEFT JOIN rate r ON r.stage_id = ss.stage_id
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- Clicks and opt-outs gain the membership predicate 0128 omitted, deduplicated
-- at the CELL's grain: someone who clicked three campaigns of this offer, all
-- targeting this group, is one clicker in this cell.
cell_clicks AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = cc.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
cell_optouts AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT oa.opt_out_id)::bigint AS n
  FROM public.opt_out_attributions oa
  JOIN public.stage_sends ss ON ss.id = oa.stage_send_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- Unchanged from 0128: contacts in the group with no 'sent' row in 90 days,
-- across ALL offers, no opt-out filter.
fresh AS (
  SELECT ccg.contact_group_id AS group_id, ct.org_id, COUNT(*)::bigint AS fresh_pool
  FROM public.contacts ct
  JOIN public.contact_contact_groups ccg ON ccg.contact_id = ct.id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.stage_sends s2
    WHERE s2.contact_id = ct.id AND s2.status = 'sent'
      AND s2.sent_at >= now() - interval '90 days'
  )
  GROUP BY ccg.contact_group_id, ct.org_id
)
SELECT a.org_id, a.offer_id, a.group_id, cg.name AS group_name,
  a.sends, a.revenue, a.sales,
  COALESCE(ck.n, 0)::bigint AS clicks,
  a.cost,
  COALESCE(oo.n, 0)::bigint AS optouts,
  a.sent_7d, a.sent_30d, a.sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM attr a
LEFT JOIN public.contact_groups cg ON cg.id = a.group_id
LEFT JOIN cell_clicks  ck ON ck.org_id = a.org_id AND ck.offer_id = a.offer_id AND ck.group_id = a.group_id
LEFT JOIN cell_optouts oo ON oo.org_id = a.org_id AND oo.offer_id = a.offer_id AND oo.group_id = a.group_id
LEFT JOIN fresh f ON f.org_id = a.org_id AND f.group_id = a.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_report_offer_totals_mv', now())
ON CONFLICT (view_name) DO UPDATE SET refreshed_at = now();
```

- [ ] **Step 2: Confirm the file has LF endings**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && file db/migrations/0132_offer_report_per_recipient_attribution.sql
```

Expected: `ASCII text` — **not** `ASCII text, with CRLF line terminators`. If CRLF, re-save with LF; `.gitattributes` normalizes on commit but the hash check reads the working file.

- [ ] **Step 3: Clone the snapshot forward**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib
sed -e 's/"id": "0131a000-0131-4131-8131-000000000131"/"id": "0132a000-0132-4132-8132-000000000132"/' \
    -e 's/"prevId": "0130a000-0130-4130-8130-000000000130"/"prevId": "0131a000-0131-4131-8131-000000000131"/' \
    db/migrations/meta/0131_snapshot.json > db/migrations/meta/0132_snapshot.json
head -c 200 db/migrations/meta/0132_snapshot.json
```

Expected: `"id": "0132a000-...-000000000132"` and `"prevId": "0131a000-...-000000000131"`. Matviews are raw SQL and absent from `db/schema.ts`, so the snapshot body is an unchanged clone — only the chain ids move.

- [ ] **Step 4: Append the journal entry**

Add to the `entries` array in `db/migrations/meta/_journal.json`, after the `idx: 131` entry:

```json
    {
      "idx": 132,
      "version": "7",
      "when": 1787788800000,
      "tag": "0132_offer_report_per_recipient_attribution",
      "breakpoints": true
    }
```

- [ ] **Step 5: Verify the chain without applying anything**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/verify-migration-integrity.ts
```

Expected: reports 0132 as present-on-disk / not-yet-applied, and the snapshot chain as clean. It is a read-only diagnostic. **Do not run `npm run db:migrate`** — that is Task 8, gated on Dmytro.

- [ ] **Step 6: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add db/migrations/0132_offer_report_per_recipient_attribution.sql db/migrations/meta/0132_snapshot.json db/migrations/meta/_journal.json
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "feat(reports): migration 0132 -- per-recipient offer group attribution

Replaces the unnest(group_ids) fan-out with stage_sends x
contact_contact_groups on the actual recipient, and adds an offer-grain
totals matview so the footer survives an offer with zero group rows.
NOT APPLIED -- gated on explicit approval."
```

---

### Task 3: Read + refresh helper

**Files:**
- Modify: `lib/reporting/offer-group-report.ts`

**Interfaces:**
- Consumes: the matview column lists from Task 2.
- Produces:
  - `type GroupRawRow = RawMetrics & { group_id: number; group_name: string; sent_7d: number; sent_30d: number; sent_90d: number; fresh_pool: number }` — **`has_manual_stages` removed**.
  - `type OfferTotals = RawMetrics & { has_manual_stages: boolean; attributable_sends: number; unattributed_sends: number }`
  - `type OfferGroupReport = { rows: GroupRawRow[]; offerTotals: OfferTotals; orgBenchmark: RawMetrics; benchmarkHasManual: boolean; refreshedAt: string | null }` — `offerClicks` and `offerHasManual` removed.
  - `type RefreshDurations = { totalsMs: number; summaryMs: number; groupMs: number; totalMs: number }`
  - Task 4 consumes all of these.

- [ ] **Step 1: Replace the types and the read function**

In `lib/reporting/offer-group-report.ts`, replace everything from `export type GroupRawRow` through the end of `getOfferGroupReport` with:

```ts
export type GroupRawRow = RawMetrics & {
  group_id: number;
  group_name: string;
  sent_7d: number;
  sent_30d: number;
  sent_90d: number;
  fresh_pool: number;
};

// Offer grain. Read from its own matview rather than summed from the group
// rows: those are per-recipient full counts and a contact in three of the
// offer's groups appears in three of them. Summing was the defect 0132 removed.
export type OfferTotals = RawMetrics & {
  has_manual_stages: boolean;
  attributable_sends: number;
  // sends - attributable_sends. Recorded outside the app (no per-recipient
  // row), or on a campaign that targeted no group. Cannot reach a group row.
  unattributed_sends: number;
  // The group rows' revenue/sales come from a DIFFERENT source than this row's:
  // per-recipient stage_sends.sale_revenue / converted_at, versus Keitaro's
  // per-stage aggregate (and GREATEST(keitaro, manual) for sales). Coverage is
  // ~97% of revenue and ~90% of sales, so a group row is systematically a little
  // lower than its share of the footer. These two carry the same figures on the
  // group rows' basis so the gap is visible instead of being read as a shortfall.
  // NOT a whole-and-part pair with revenue/sales — do not subtract them.
  attributable_revenue: number;
  attributable_sales: number;
};

export type OfferGroupReport = {
  rows: GroupRawRow[];
  offerTotals: OfferTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  refreshedAt: string | null;
};

const ZERO: RawMetrics = { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 };

// Read the precomputed report for one offer, org-scoped. Sorting is done
// client-side (tiny row set), so no ORDER BY here.
export async function getOfferGroupReport(
  orgId: string,
  offerId: number,
): Promise<OfferGroupReport> {
  const groupRows = (await db.execute(sql`
    select group_id, group_name, sends, revenue, sales, clicks, cost, optouts,
           sent_7d, sent_30d, sent_90d, fresh_pool
    from offer_group_report_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  // Separate matview, not groupRows[0]: an offer whose sends were all recorded
  // outside the app has NO group rows, and still needs a footer.
  const totalsRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages,
           attributable_sends, unattributed_sends,
           attributable_revenue, attributable_sales
    from offer_report_offer_totals_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];

  const n = (v: unknown) => Number(v ?? 0);
  const t = totalsRows[0];
  return {
    rows: groupRows.map((r) => ({
      group_id: n(r.group_id),
      group_name: String(r.group_name),
      sends: n(r.sends),
      revenue: n(r.revenue),
      sales: n(r.sales),
      clicks: n(r.clicks),
      cost: n(r.cost),
      optouts: n(r.optouts),
      sent_7d: n(r.sent_7d),
      sent_30d: n(r.sent_30d),
      sent_90d: n(r.sent_90d),
      fresh_pool: n(r.fresh_pool),
    })),
    offerTotals: t
      ? {
          sends: n(t.sends),
          revenue: n(t.revenue),
          sales: n(t.sales),
          clicks: n(t.clicks),
          cost: n(t.cost),
          optouts: n(t.optouts),
          has_manual_stages: Boolean(t.has_manual_stages),
          attributable_sends: n(t.attributable_sends),
          unattributed_sends: n(t.unattributed_sends),
          attributable_revenue: n(t.attributable_revenue),
          attributable_sales: n(t.attributable_sales),
        }
      : {
          ...ZERO,
          has_manual_stages: false,
          attributable_sends: 0,
          unattributed_sends: 0,
          attributable_revenue: 0,
          attributable_sales: 0,
        },
    orgBenchmark: benchRows[0]
      ? {
          sends: n(benchRows[0].sends),
          revenue: n(benchRows[0].revenue),
          sales: n(benchRows[0].sales),
          clicks: n(benchRows[0].clicks),
          cost: n(benchRows[0].cost),
          optouts: n(benchRows[0].optouts),
        }
      : { ...ZERO },
    benchmarkHasManual: Boolean(benchRows[0]?.has_manual_stages),
    refreshedAt: logRows[0]?.refreshed_at
      ? new Date(logRows[0].refreshed_at).toISOString()
      : null,
  };
}
```

- [ ] **Step 2: Update the refresh function**

Replace `RefreshDurations` and `refreshOfferGroupReport` with:

```ts
export type RefreshDurations = {
  totalsMs: number;
  summaryMs: number;
  groupMs: number;
  totalMs: number;
};

// Rebuild all three matviews (CONCURRENTLY -- non-blocking) and stamp the
// refresh log. Called by the twice-daily cron. CONCURRENTLY must run outside a
// transaction, so each statement is its own execute() call.
//
// The group matview reads no other matview, so order is not load-bearing; the
// totals matview goes first only so the footer is never newer than the rows a
// reader is looking at. Measured 2026-08-13: totals ~4.5s, summary ~11s, group
// ~25s -- ~40.5s against a 300s ceiling.
export async function refreshOfferGroupReport(): Promise<RefreshDurations> {
  const t0 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_report_offer_totals_mv`);
  const t1 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_report_org_summary_mv`);
  const t2 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_group_report_mv`);
  const t3 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now()
    where view_name in ('offer_group_report_mv', 'offer_report_org_summary_mv',
                        'offer_report_offer_totals_mv')
  `);
  return {
    totalsMs: t1 - t0,
    summaryMs: t2 - t1,
    groupMs: t3 - t2,
    totalMs: Date.now() - t0,
  };
}
```

- [ ] **Step 3: Update the cron's log line**

In `app/api/cron/refresh-offer-group-report/route.ts`, replace the success `console.log` (line 29–31) with:

```ts
    console.log(
      `[refresh-offer-group-report] ok totalsMs=${durations.totalsMs} summaryMs=${durations.summaryMs} groupMs=${durations.groupMs} totalMs=${durations.totalMs}`,
    );
```

- [ ] **Step 4: Typecheck**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsc --noEmit
```

Expected: errors ONLY in `app/api/offers/[id]/report/route.ts` and `app/(protected)/offers/[id]/report/page.tsx` — they still reference the removed `offerClicks` / `offerHasManual` / `has_manual_stages`. Tasks 4 and 5 fix those. No errors in `lib/` or the cron route.

- [ ] **Step 5: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add lib/reporting/offer-group-report.ts app/api/cron/refresh-offer-group-report/route.ts
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "feat(reports): read offer totals from their own matview, refresh three views"
```

---

### Task 4: API route

**Files:**
- Modify: `app/api/offers/[id]/report/route.ts:43-79`

**Interfaces:**
- Consumes: `getOfferGroupReport` and the types from Task 3.
- Produces: response `{ offerName, rows, offerTotals, orgBenchmark, benchmarkHasManual, breakEvenPer1k, unattributedSends, refreshedAt }`. Task 5 consumes it. `offerHasManual` is gone — it now lives on `offerTotals.has_manual_stages`.

- [ ] **Step 1: Replace the footer computation**

Replace lines 43–79 (from `const report = await getOfferGroupReport(...)` to the end of the `NextResponse.json({...})` call) with:

```ts
  const report = await getOfferGroupReport(orgId, offerId);

  // The footer is read at OFFER grain, never summed from the group rows. Those
  // rows are per-recipient full counts and a contact in three of this offer's
  // groups appears in three of them -- summing them read 904,926 sends against
  // a true 88,536 on offer 96. The columns above this footer therefore do not
  // add up to it, which is stated in the UI rather than papered over.
  const { offerTotals } = report;

  const breakEvenPer1k =
    offerTotals.sends > 0 ? (offerTotals.cost / offerTotals.sends) * 1000 : null;

  return NextResponse.json({
    offerName: offer.name,
    rows: report.rows,
    offerTotals,
    orgBenchmark: report.orgBenchmark,
    benchmarkHasManual: report.benchmarkHasManual,
    breakEvenPer1k,
    // Sends that cannot reach any group row: recorded entirely outside the app
    // (no per-recipient row), or on a campaign that targeted no group.
    unattributedSends: offerTotals.unattributed_sends,
    refreshedAt: report.refreshedAt,
  });
```

Also delete the now-unused `type RawMetrics` from the import on lines 9–12, leaving:

```ts
import { getOfferGroupReport } from "@/lib/reporting/offer-group-report";
```

- [ ] **Step 2: Typecheck**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsc --noEmit
```

Expected: errors now ONLY in `app/(protected)/offers/[id]/report/page.tsx`. None in `app/api/`.

- [ ] **Step 3: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add "app/api/offers/[id]/report/route.ts"
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "feat(reports): footer reads offer-grain totals instead of summing group rows"
```

---

### Task 5: Report page

**Files:**
- Modify: `app/(protected)/offers/[id]/report/page.tsx`

**Interfaces:**
- Consumes: the API response from Task 4 and `GroupRawRow` / `OfferTotals` from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Update the response type and imports**

Replace the import on line 11 and the `ReportResponse` type (lines 13–22) with:

```tsx
import type {
  RawMetrics,
  GroupRawRow,
  OfferTotals,
} from "@/lib/reporting/offer-group-report";

type ReportResponse = {
  offerName: string;
  rows: GroupRawRow[];
  offerTotals: OfferTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  breakEvenPer1k: number | null;
  unattributedSends: number;
  refreshedAt: string | null;
};
```

- [ ] **Step 2: Update the ManualMix comment and the row rendering**

Replace the comment block above `function ManualMix()` (lines 40–43) with:

```tsx
// Rows whose clicks mix a deduplicated contact count with Keitaro visit counts
// (manual-mode stages mint no links, so there is no set to deduplicate). Since
// migration 0132 this can only occur on the offer footer and the org benchmark:
// a group row is built from per-recipient rows, and every manual-fallback visit
// in this data sits on a stage that has none. Verified, not assumed -- of 938
// sent stages, the 22 with sends but no clickers all have zero visits.
```

Replace the group-row `<td>` (lines 294–299) with:

```tsx
              <tr key={r.group_id} className="border-t">
                <td className="px-3 py-2">{r.group_name}</td>
                <MetricCells m={r} isGroup breakEven={breakEven} />
              </tr>
```

Replace the offer-total row's label cell (lines 303–307) with:

```tsx
                <td className="px-3 py-2">
                  This offer · all groups
                  {data?.offerTotals.has_manual_stages ? <ManualMix /> : null}
                </td>
```

- [ ] **Step 3: Add the un-attributed line and rewrite the footnote**

Replace the closing `<p className="text-xs text-muted-foreground">…</p>` block (lines 322–332) with:

```tsx
      {data && data.unattributedSends > 0 ? (
        <p className="text-xs text-muted-foreground">
          <strong>{fmtInt(data.unattributedSends)} sends</strong>{" "}
          ({((data.unattributedSends / Math.max(data.offerTotals.sends, 1)) * 100).toFixed(1)}%)
          were recorded outside the app with no per-recipient detail, so they are in
          the offer total but not in any group row.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Every metric is counted <em>per recipient</em>: a group row covers the
        messages actually sent to contacts in that group. Because a contact can
        belong to several groups, <strong>the columns do not add up to the offer
        total</strong> — the same person is one send on the offer row and one send
        in each of their groups. “Sent last 7/30/90d” and “Fresh pool” count every
        in-app send (tracked or manual link mode); sends performed entirely outside
        the app aren’t included anywhere except the offer total.
      </p>
```

- [ ] **Step 4: Typecheck and build**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsc --noEmit && npm run build
```

Expected: `npx tsc --noEmit` clean. `npm run build` succeeds.

- [ ] **Step 5: Lint the changed files only**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib
npx eslint "app/(protected)/offers/[id]/report/page.tsx" "app/api/offers/[id]/report/route.ts" lib/reporting/offer-group-report.ts scripts/verify-offer-group-attribution.ts
```

Expected: **exactly `✖ 2 problems (1 error, 1 warning)`** — the pre-change baseline, captured on this branch before any edits. Both live in `page.tsx` and are unrelated to this work:

- `165:6 warning react-hooks/exhaustive-deps` — `useCallback` missing dependency `api`
- `167:26 error react-hooks/set-state-in-effect` — `useEffect(() => { void load(); }, [load])`

Anything above 2, or any problem in `route.ts` / `offer-group-report.ts` / the verify script, is new and must be fixed. Do not "fix" the two baseline problems — they are outside this task's scope and touching the effect wiring risks the fetch loop documented in the repo's `useApiCall` convention.

This repo uses **flat ESLint config** (`eslint.config.mjs`); there is no `.eslintrc.json`, so `--no-eslintrc` / `--config .eslintrc.json` will fail. Do not run `npm run lint` either — it lints all 9 worktrees (8.4MB, ~5min) and exits 1 on other branches' problems.

- [ ] **Step 6: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add "app/(protected)/offers/[id]/report/page.tsx"
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "feat(reports): footer reads offer grain; state the non-additive rule in the UI"
```

---

### Task 6: Documentation

Mandatory per CLAUDE.md. Three definitions in the feature doc are stale independently of this change and are corrected here.

**Files:**
- Modify: `docs/04-features/offer-group-report.md`
- Modify: `docs/03-data-model.md` (reporting section + Mermaid ERD)
- Modify: `docs/07-conventions.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Rewrite the metric definitions in the feature doc**

In `docs/04-features/offer-group-report.md`, set `_Last updated: 2026-08-14_`, and replace the Sends / Revenue / Sales / Cost / Clicks / Opt-outs / Sent-7-30-90 / Fresh-pool rows of the metric table with:

| Metric | Definition |
|---|---|
| **Sends** | Group row: `COUNT(*)` of `stage_sends` rows with `status='sent'` whose recipient is in the group AND whose campaign targeted it (`link_mode='tracked'` only). Footer/benchmark: campaign-grain, per `campaigns.link_mode` — `tracked` → `stage_sends` count, `manual` → `Σ campaign_stages.sms_count`. |
| **Revenue** | Group row: `Σ stage_sends.sale_revenue` over the same attributed rows. Footer: `Σ keitaro_stage_results.revenue`. The two agreed exactly on offer 96 and to 97.2% org-wide. |
| **Sales** | Group row: `COUNT(*)` of attributed rows with `converted_at IS NOT NULL`. Footer: per stage `GREATEST(Σ keitaro.sales, Σ stage_manual_sales.delta)`. Manual sales carry no recipient, so a group row can be lower than its share of the footer (812 vs 842 org-wide). |
| **Cost** | Group row: `Σ (campaign_stages.total_cost / that stage's sent-row count)` over attributed rows. **Not** `stage_sends.cost_per_sms` — NULL on 32.7% of rows. Footer: `Σ campaign_stages.total_cost` for non-archived sent stages. |
| **Clicks (EPC denominator)** | Group row: `COUNT(DISTINCT counted_clickers.contact_id)` for clickers who are in the group and whose campaign targeted it. Footer/benchmark: offer/org-grain distinct count **plus** manual-stage Keitaro visits. |
| **Opt-outs** | Group row: `COUNT(DISTINCT opt_out_id)` from `opt_out_attributions` joined through `stage_send_id` to a recipient in the group. Footer: campaign-grain distinct count. |
| **Sent last 7 / 30 / 90 days** | `COUNT(*)` of attributed `stage_sends` rows within the window — send rows, **not** distinct contacts, and scoped to **this offer**. |
| **Fresh pool** | Contacts in the group with no `status='sent'` `stage_sends` row in the last 90 days, across **all** offers. No opt-out filter. |

Then replace the "Multi-group campaigns are counted FULLY in each targeted group" paragraph with:

```markdown
**Every metric is per-recipient, and the columns do not foot.** A group row
covers the messages actually sent to contacts in that group. Because a contact
can belong to several groups, the same send appears in each of their group rows —
so the columns sum to more than the offer footer (+18.7% on sends, +37.5% on
revenue for offer 96 as of 2026-08-13). The footer is read at offer grain from
`offer_report_offer_totals_mv`, never summed from the rows. This is the same
dedup-at-display-grain rule migration 0128 applied to clicks, extended to every
column by migration 0132.

**Sends recorded outside the app cannot reach a group row.** ~4.9% of sends have
no per-recipient row (an operator hand-recorded `campaign_stages.sms_count`).
They appear in the footer and are called out beneath the table. Six of 21 offers
are 100% external and render no group rows at all.
```

- [ ] **Step 2: Update the data model doc and ERD**

In `docs/03-data-model.md`, set the "last updated" date, and in the reporting section add:

```markdown
- **`offer_report_tracked_campaigns`** (plain view, migration 0132) — the
  attribution universe: campaigns with an offer, `link_mode='tracked'`, and at
  least one sent stage. Both matviews below select from it so their campaign sets
  cannot drift apart.
- **`offer_report_offer_totals_mv`** (materialized, unique on `(org_id, offer_id)`,
  migration 0132) — offer-grain campaign totals plus `attributable_sends` and
  `unattributed_sends`. Exists for every offer with a sent campaign, including
  offers whose sends were all recorded outside the app, so the report footer
  renders even when there are zero group rows.
```

Update the `offer_group_report_mv` bullet to note it lost `has_manual_stages`, `offer_clicks` and `offer_has_manual` (moved to the totals matview) and is now built per-recipient. Add the new matview to the Mermaid ERD alongside the other two.

- [ ] **Step 3: Add the conventions entries**

Append to `docs/07-conventions.md` (and set its date):

```markdown
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
  ~97% of revenue and **~90% of the footer's sales basis** — quote that against
  `GREATEST(...)`, not against Keitaro sales alone (which reads ~96% and
  understates the gap). `offer_report_offer_totals_mv.attributable_revenue` /
  `.attributable_sales` carry the footer's own figures on the group rows' basis so
  the difference is measurable. They are **not** a whole-and-part pair with
  `revenue`/`sales` — never subtract them to derive an "unattributed" amount.
```

- [ ] **Step 4: Append the changelog line**

Append to `docs/CHANGELOG.md`:

```
2026-08-14 — Offer group report attributed per recipient (migration 0132); footer moved to a new offer-grain matview; three stale metric definitions corrected — docs/03-data-model.md, docs/04-features/offer-group-report.md, docs/07-conventions.md
```

- [ ] **Step 5: Commit**

```bash
git -C C:/AFF/camman/.claude/worktrees/og-attrib add docs/
git -C C:/AFF/camman/.claude/worktrees/og-attrib commit -m "docs: per-recipient offer group attribution; fix three stale metric definitions"
```

---

### Task 7: Pre-apply review checkpoint

**Files:** none.

- [ ] **Step 1: Confirm nothing has been applied**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/verify-migration-integrity.ts
```

Expected: 0132 on disk, not applied; chain clean.

- [ ] **Step 2: Confirm the shared checkout is untouched**

```bash
git -C C:/AFF/camman log --oneline -1
git -C C:/AFF/camman status --short
```

Expected: HEAD unchanged from session start, and only the three `docs/` files another session left modified. If this worktree's work appears here, it leaked — stop and report.

- [ ] **Step 3: Report to Dmytro and STOP**

Summarize: the diff, the projected refresh (~40.5s vs 300s ceiling), the fact that numbers on screen will drop up to ~10x and five rows change colour, and that the six fully-external offers will show no group rows. **Wait for explicit go before Task 8.**

---

### Task 8: GATED — apply the migration and verify

**Do not start this task without Dmytro's explicit go-ahead.** It writes to the shared production database.

**Files:** none (execution only).

- [ ] **Step 1: Snapshot the benchmark immediately before applying**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib
npx tsx -e "
import './scripts/_env-preload';
import postgres from 'postgres';
const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const r = await c\`select * from offer_report_org_summary_mv\`;
console.log(JSON.stringify(r, null, 2));
await c.end();
"
```

Save the output. Criterion 4 compares against **this**, not against any number written in the spec — the benchmark moved 3,106,967 → 3,135,015 while the spec was being written.

- [ ] **Step 2: Apply**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npm run db:migrate
```

Expected: `0132_offer_report_per_recipient_attribution` applied. The DROP and both CREATEs run in one migration; the report is empty only for that window.

- [ ] **Step 3: Verify chain integrity**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/verify-migration-integrity.ts
```

Expected: clean, 0132 applied, hashes match.

- [ ] **Step 4: Re-read the benchmark and compare (criterion 4)**

Re-run the Step 1 command. Expected: identical to the Step 1 output. The migration does not touch that matview. If it differs, check whether the twice-daily cron (05:00/20:00 UTC) landed mid-run before treating it as a failure.

- [ ] **Step 5: Run the full verification (criteria 1, 2, 3a, 3b, 5, 6)**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/verify-offer-group-attribution.ts
```

Expected: every check `✓`, `verify-offer-group-attribution OK.`, exit 0. The offer-96 overlap ratio should print near 1.19x; ~10x means the fan-out survived.

- [ ] **Step 6: Time a refresh (criterion 7)**

```bash
cd C:/AFF/camman/.claude/worktrees/og-attrib && npx tsx scripts/test-offer-group-report-helper.ts
```

Expected: `refresh completed` and all checks pass. Then confirm the timing is under 60s from the cron log line format added in Task 3.

Note: that script pins offer 62 and asserts `sent_7d <= sent_30d <= sent_90d`, which still holds — those are cumulative windows over the same attributed rows.

- [ ] **Step 7: Commit nothing, report results**

Nothing to commit — the migration file was committed in Task 2. Report the verification output, the measured refresh durations, and the before/after for offer 96.

---

## Self-Review

**Spec coverage:** §4.1 data layer → Task 2 (the `unattributed_cost` omission is stated at the top of this plan). §4.2 API → Tasks 3–4. §4.3 UI → Task 5. §4.4 docs → Task 6. §8 criteria 1, 2, 3a, 3b, 5, 6 → Task 1's script; criterion 4 → Task 8 Steps 1 and 4; criterion 7 → Task 8 Step 6; criterion 8 → Task 8 Step 3; criterion 9 → Task 5 Step 5. §9 gate → Tasks 7 and 8.

**Placeholders:** none — every step carries the actual SQL, TypeScript, or command.

**Type consistency:** `GroupRawRow` loses `has_manual_stages` in Task 3 and Task 5 stops rendering it. `OfferTotals` is introduced in Task 3, returned by Task 4, consumed in Task 5 as `data.offerTotals.has_manual_stages`. `RefreshDurations` gains `totalsMs`, used in Task 3 Step 3's log line. The API's `unattributedSends` (camelCase) maps from `offerTotals.unattributed_sends` (snake, matching the matview column) — deliberate and consistent with the existing route's `breakEvenPer1k`.
