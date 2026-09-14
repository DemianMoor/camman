import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { getAudienceGroups, getAudienceReport } from "@/lib/reporting/audience-report";

// =============================================================================
// AUDIENCE STATS REPORT — VERIFICATION (ClickUp 869eydqn0, migration 0180)
//
// Read-only. Every check computes both sides in this run; nothing is compared
// against a number copied from the spec — production keeps sending and the
// matviews refresh twice daily, so a pinned constant measures the calendar.
//
// Run (after 0180 is applied to the target DB):
//   npx tsx scripts/verify-audience-report.ts
// =============================================================================

let failed = 0;
let passed = 0;
let skipped = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
function skip(criterion: string, reason: string) {
  skipped++;
  console.log(`  ~ SKIPPED (${criterion}): ${reason}`);
}

const NO_DATA_ORG = "00000000-0000-0000-0000-000000000000";

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
  const d = drizzle(c);
  const q = async (x: ReturnType<typeof sql>) =>
    (await d.execute(x)) as unknown as Record<string, unknown>[];
  const n = (v: unknown) => Number(v ?? 0);
  const ms = (v: unknown) => (v == null ? null : new Date(String(v)).getTime());

  // --- INPUT SCOPE, printed before any verdict. A check is not evidence until
  // you know what it ran against.
  const [scope] = await q(sql`
    SELECT
      (SELECT count(*) FROM audience_report_group_totals_mv)::int              AS totals_rows,
      (SELECT count(DISTINCT org_id) FROM audience_report_group_totals_mv)::int AS orgs,
      (SELECT count(*) FROM offer_group_report_mv)::int                         AS cells,
      (SELECT refreshed_at FROM report_refresh_log WHERE view_name = 'offer_group_report_mv')           AS cells_at,
      (SELECT refreshed_at FROM report_refresh_log WHERE view_name = 'audience_report_group_totals_mv') AS totals_at,
      (SELECT count(*) FROM report_refresh_log WHERE view_name = 'audience_report_group_totals_mv')::int AS log_rows
  `);
  console.log("=== scope ===");
  console.log(`  database user: ${new URL(process.env.DATABASE_URL!).username}`);
  console.log(`  audience_report_group_totals_mv: ${scope.totals_rows} group rows across ${scope.orgs} org(s)`);
  console.log(`  offer_group_report_mv: ${scope.cells} offer x group cells`);
  console.log(`  refreshed: cells ${scope.cells_at ?? "never"} · totals ${scope.totals_at ?? "never by the cron (seeded NULL)"}`);
  if (n(scope.totals_rows) === 0) {
    assert(false, "scope is EMPTY — nothing to verify (an empty scope is a failure, not a pass)");
    return;
  }

  // The totals are derived from the cells, and the cron refreshes the cells
  // first. When the cells' stamp is newer than the totals' (a refresh in
  // flight, a failed totals refresh, or totals not yet cron-refreshed since the
  // migration built them), stored-vs-stored comparisons can legitimately
  // differ: those checks compare anyway and SKIP with this reason on mismatch.
  const cellsAt = ms(scope.cells_at);
  const totalsAt = ms(scope.totals_at);
  const outOfOrder = cellsAt != null && (totalsAt == null || cellsAt > totalsAt);
  const orderNote = "the cells were refreshed after the totals, so a difference is expected until the next cron run";

  // --- a. Additive columns.
  console.log("\n=== a. additive totals = sum of the group's offer cells ===");
  const [sums] = await q(sql`
    WITH s AS (
      SELECT org_id, group_id,
             SUM(sends) AS sends, SUM(revenue) AS revenue, SUM(sales) AS sales, SUM(cost) AS cost,
             SUM(sent_7d) AS sent_7d, SUM(sent_30d) AS sent_30d, SUM(sent_90d) AS sent_90d
      FROM offer_group_report_mv
      GROUP BY org_id, group_id
    )
    SELECT count(*)::int AS groups,
      count(*) FILTER (WHERE t.org_id IS NULL OR s.org_id IS NULL
        OR t.sends <> s.sends OR t.revenue <> s.revenue OR t.sales <> s.sales
        OR t.cost <> s.cost OR t.sent_7d <> s.sent_7d OR t.sent_30d <> s.sent_30d
        OR t.sent_90d <> s.sent_90d)::int AS mismatched
    FROM audience_report_group_totals_mv t
    FULL JOIN s ON s.org_id = t.org_id AND s.group_id = t.group_id
  `);
  if (n(sums.mismatched) === 0) {
    assert(true, `all ${sums.groups} groups: sends/revenue/sales/cost/sent_7d/30d/90d equal the cell sums, and the group sets match`);
  } else if (outOfOrder) {
    skip("a", `${sums.mismatched} of ${sums.groups} groups differ — ${orderNote}`);
  } else {
    assert(false, `${sums.mismatched} of ${sums.groups} groups differ from the sum of their cells`);
  }

  // --- b. Group-grain dedup, against the SHIPPED definition.
  // The group side is the matview's own definition read from pg_matviews and
  // executed, not a copy in this file — so a regression in the migration (a
  // summed click count, a dropped membership predicate, a lost org join) is what
  // gets tested. The cell side mirrors offer_group_report_mv's cell_clicks /
  // cell_optouts. Both run in ONE repeatable-read snapshot, so the bounds are
  // exact: no click can land between the two sides.
  console.log("\n=== b. group-grain dedup: max(cell) <= group total <= sum(cells) ===");
  const [defRow] = await q(sql`
    SELECT definition FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname = 'audience_report_group_totals_mv'
  `);
  const shipped = String(defRow.definition).trim().replace(/;\s*$/, "");
  const bounds = (await c.begin("isolation level repeatable read read only", (tx) =>
    tx.unsafe(`
      WITH shipped AS (${shipped}),
      cell_clicks AS (
        SELECT camp.org_id, ccg.contact_group_id AS group_id, camp.offer_id,
               COUNT(DISTINCT cc.contact_id) AS n
        FROM counted_clickers cc
        JOIN offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
        JOIN contact_contact_groups ccg
          ON ccg.contact_id = cc.contact_id
         AND ccg.contact_group_id = ANY(camp.gids)
         AND ccg.org_id = camp.org_id
        GROUP BY 1, 2, 3
      ),
      -- Recipient via opt_outs.contact_id, as the matview does; criterion c
      -- proves that equals the stage_sends recipient cell_optouts uses.
      cell_optouts AS (
        SELECT camp.org_id, ccg.contact_group_id AS group_id, camp.offer_id,
               COUNT(DISTINCT oa.opt_out_id) AS n
        FROM opt_out_attributions oa
        JOIN opt_outs o ON o.id = oa.opt_out_id
        JOIN campaign_stages cs ON cs.id = oa.stage_id
        JOIN offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
        JOIN contact_contact_groups ccg
          ON ccg.contact_id = o.contact_id
         AND ccg.contact_group_id = ANY(camp.gids)
         AND ccg.org_id = camp.org_id
        WHERE oa.stage_send_id IS NOT NULL
        GROUP BY 1, 2, 3
      ),
      k AS (SELECT org_id, group_id, max(n) AS max_n, sum(n) AS sum_n FROM cell_clicks GROUP BY 1, 2),
      o AS (SELECT org_id, group_id, max(n) AS max_n, sum(n) AS sum_n FROM cell_optouts GROUP BY 1, 2)
      SELECT s.org_id, s.group_id, s.clicks, s.optouts,
             COALESCE(k.max_n, 0) AS clicks_max, COALESCE(k.sum_n, 0) AS clicks_sum,
             COALESCE(o.max_n, 0) AS optouts_max, COALESCE(o.sum_n, 0) AS optouts_sum
      FROM shipped s
      LEFT JOIN k ON k.org_id = s.org_id AND k.group_id = s.group_id
      LEFT JOIN o ON o.org_id = s.org_id AND o.group_id = s.group_id
    `),
  )) as unknown as Record<string, unknown>[];
  const outside = bounds.filter(
    (r) =>
      !(n(r.clicks) >= n(r.clicks_max) && n(r.clicks) <= n(r.clicks_sum) &&
        n(r.optouts) >= n(r.optouts_max) && n(r.optouts) <= n(r.optouts_sum)),
  );
  assert(
    bounds.length > 0 && outside.length === 0,
    `${bounds.length} groups, one snapshot: clicks and opt-outs sit within [largest cell, sum of cells]` +
      (outside.length
        ? ` — ${outside.length} OUTSIDE: ${outside.slice(0, 5).map((r) =>
            `group ${r.group_id} clicks ${r.clicks} in [${r.clicks_max}, ${r.clicks_sum}], optouts ${r.optouts} in [${r.optouts_max}, ${r.optouts_sum}]`).join("; ")}`
        : ""),
  );
  const dedupClicks = bounds.filter((r) => n(r.clicks) < n(r.clicks_sum)).length;
  const dedupOptouts = bounds.filter((r) => n(r.optouts) < n(r.optouts_sum)).length;
  console.log(`  · dedup exercised: clicks below the cell sum in ${dedupClicks} group(s), opt-outs in ${dedupOptouts}`);

  // Stored totals vs stored cells: only the lower bound is stable across the
  // seconds between the two refreshes (a new clicker can arrive in between).
  const [stored] = await q(sql`
    WITH mx AS (
      SELECT org_id, group_id, max(clicks) AS clicks, max(optouts) AS optouts
      FROM offer_group_report_mv GROUP BY org_id, group_id
    )
    SELECT count(*)::int AS groups,
           count(*) FILTER (WHERE t.clicks < mx.clicks OR t.optouts < mx.optouts)::int AS below
    FROM audience_report_group_totals_mv t
    JOIN mx ON mx.org_id = t.org_id AND mx.group_id = t.group_id
  `);
  if (n(stored.below) === 0) {
    assert(true, `stored: every group's clicks/opt-outs >= its largest stored cell (${stored.groups} groups)`);
  } else if (outOfOrder) {
    skip("b-stored", `${stored.below} of ${stored.groups} groups below their largest cell — ${orderNote}`);
  } else {
    assert(false, `stored: ${stored.below} of ${stored.groups} groups have clicks or opt-outs below their largest cell`);
  }

  // --- c. The substitution the matview relies on.
  console.log("\n=== c. an opt-out's contact is the recipient of the send it is credited to ===");
  const [inv] = await q(sql`
    SELECT count(*)::int AS attributions,
           count(*) FILTER (WHERE ss.contact_id IS DISTINCT FROM o.contact_id)::int AS mismatched
    FROM opt_out_attributions oa
    JOIN opt_outs o ON o.id = oa.opt_out_id
    JOIN stage_sends ss ON ss.id = oa.stage_send_id
  `);
  assert(
    n(inv.attributions) > 0 && n(inv.mismatched) === 0,
    `${inv.mismatched} of ${inv.attributions} attributions disagree (opt_outs.contact_id vs stage_sends.contact_id) — must be 0, the matview reads the first in place of the second`,
  );

  // --- d. The helper returns every cell, archived offers included.
  console.log("\n=== d. helper = matview cells for every group, archived offers included ===");
  const orgRows = await q(sql`SELECT DISTINCT org_id FROM audience_report_group_totals_mv`);
  const problems: string[] = [];
  let groupsChecked = 0;
  let rowsChecked = 0;
  let archivedRows = 0;
  for (const { org_id } of orgRows) {
    const orgId = String(org_id);
    const pickerGroups = await getAudienceGroups(orgId);
    // Anchor: the groups that HAVE cells (and still exist), not the helper's own query.
    const cellGroups = await q(sql`
      SELECT DISTINCT m.group_id FROM offer_group_report_mv m
      JOIN contact_groups g ON g.id = m.group_id AND g.org_id = m.org_id
      WHERE m.org_id = ${orgId}::uuid
    `);
    const picker = new Set(pickerGroups.map((g) => g.id));
    const sameGroups = picker.size === cellGroups.length && cellGroups.every((r) => picker.has(n(r.group_id)));
    if (!sameGroups && !outOfOrder) {
      problems.push(`org ${orgId}: picker lists ${picker.size} groups, cells cover ${cellGroups.length}`);
    }

    for (const g of pickerGroups) {
      const report = await getAudienceReport(orgId, g.id);
      const cells = await q(sql`
        SELECT m.offer_id, m.sends, o.status
        FROM offer_group_report_mv m
        LEFT JOIN offers o ON o.id = m.offer_id AND o.org_id = m.org_id
        WHERE m.org_id = ${orgId}::uuid AND m.group_id = ${g.id}
      `);
      const want = new Set(cells.map((r) => `${n(r.offer_id)}:${n(r.sends)}`));
      const got = new Set(report.rows.map((r) => `${r.offer_id}:${r.sends}`));
      if (want.size !== got.size || [...want].some((k) => !got.has(k))) {
        problems.push(`group ${g.id}: helper returned ${got.size} offer rows, matview has ${want.size}`);
      }
      const archivedInCells = cells.filter((r) => r.status === "archived").length;
      const archivedInHelper = report.rows.filter((r) => r.offer_archived).length;
      if (archivedInCells !== archivedInHelper) {
        problems.push(`group ${g.id}: ${archivedInCells} archived offers in the matview, ${archivedInHelper} flagged by the helper`);
      }
      groupsChecked++;
      rowsChecked += report.rows.length;
      archivedRows += archivedInHelper;
    }
  }
  console.log(`  scope: ${groupsChecked} groups, ${rowsChecked} offer rows, ${archivedRows} of them archived offers`);
  if (!outOfOrder) {
    assert(groupsChecked > 0 && problems.length === 0,
      `helper rows match the matview for every group${problems.length ? ` — ${problems.slice(0, 5).join("; ")}` : ""}`);
  } else if (groupsChecked > 0 && problems.length === 0) {
    assert(true, "helper rows match the matview for every group (picker group set not compared — refresh order)");
  } else {
    assert(false, `helper rows differ from the matview — ${problems.slice(0, 5).join("; ")}`);
  }

  // --- e. Org scoping. A REAL group id, so the org filter is what empties it.
  console.log("\n=== e. org scoping ===");
  const [someGroup] = await q(sql`SELECT group_id FROM audience_report_group_totals_mv LIMIT 1`);
  const realGroupId = n(someGroup.group_id);
  const foreignGroups = await getAudienceGroups(NO_DATA_ORG);
  const foreign = await getAudienceReport(NO_DATA_ORG, realGroupId);
  assert(
    foreignGroups.length === 0 && foreign.rows.length === 0 &&
      foreign.groupTotals.sends === 0 && foreign.orgBenchmark.sends === 0,
    `an org with no data sees no groups, no rows, zero totals and a zero benchmark for real group ${realGroupId}`,
  );

  // --- f. Access and bookkeeping.
  console.log("\n=== f. access ===");
  const [grants] = await q(sql`
    SELECT has_table_privilege('anon', 'public.audience_report_group_totals_mv', 'SELECT') AS anon,
           has_table_privilege('authenticated', 'public.audience_report_group_totals_mv', 'SELECT') AS authed
  `);
  assert(grants.anon === false && grants.authed === false,
    `anon SELECT=${grants.anon}, authenticated SELECT=${grants.authed} — both must be false (matviews have no RLS)`);
  assert(n(scope.log_rows) === 1, `report_refresh_log has exactly one row for the new matview (${scope.log_rows})`);
}

main()
  .catch((err) => {
    failed++;
    console.error("\nverify-audience-report crashed:", err);
  })
  .finally(() => {
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed === 0 ? 0 : 1);
  });
