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
let passed = 0;
let skipped = 0;
// Names of criteria that were skipped, in the order they were skipped. Feeds
// the closing summary banner so it names what actually happened rather than
// a hardcoded "criterion 1" that goes stale the moment a second criterion
// grows its own skip guard.
const skippedCriteria: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
function skip(criterion: string, reason: string) {
  skipped++;
  skippedCriteria.push(criterion);
  console.log(`  ~ SKIPPED (${criterion}): ${reason}`);
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
  // Scope MUST match offer_group_report_mv's own `attr` CTE exactly, or this
  // guard can skip spuriously (or fail to skip when it should). The matview
  // resolves the campaign via the SEND's STAGE (ss.stage_id -> campaign_stages
  // -> offer_report_tracked_campaigns), not the denormalized ss.campaign_id,
  // and restricts to link_mode='tracked' campaigns with an offer set and >=1
  // sent stage. Joining ss.campaign_id -> campaigns directly (the old query
  // here) computes min(sent_at) over a WIDER set — it would include manual
  // campaigns and any send whose denormalized campaign_id disagrees with its
  // stage's campaign — so it could see an older `oldest` than the matview
  // actually contains and skip criterion 1 when it didn't need to.
  const win = (await q(sql`
    SELECT min(ss.sent_at) AS oldest, now() - interval '90 days' AS floor
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    JOIN offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
    WHERE camp.offer_id = 96 AND ss.status = 'sent'
  `))[0];
  if (!win.oldest || new Date(String(win.oldest)) < new Date(String(win.floor))) {
    skip("criterion 1", `offer 96's oldest attributable send (${win.oldest}) predates the ` +
                `90d floor (${win.floor}); the two columns are no longer the same quantity.`);
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
  const offer96Exists = n((await q(sql`
    SELECT count(*)::int AS n FROM offer_report_offer_totals_mv WHERE offer_id = 96
  `))[0].n) > 0;
  if (!offer96Exists) {
    // Without this guard: 0 == 0 passes the first assert, then `ratio` divides
    // 0 by max(0, 1) = 0, `ratio > 1` fails with a misleading "column doesn't
    // exceed footer" message that has nothing to do with the real problem —
    // offer 96 simply doesn't exist on this database.
    skip("criterion 2", "offer 96 has no row in offer_report_offer_totals_mv on this database.");
  } else {
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
  }

  // --------------------------------------------------------------- criterion 3a
  // Σ footer == a LIVE per-org aggregate of offer_report_campaign_econ,
  // asserted PER ORG. This is a SINGLE-SNAPSHOT comparison, not a cross-
  // matview one: offer_report_offer_totals_mv's own `base` CTE is defined as
  // exactly this aggregate (SUM(sends) FROM offer_report_campaign_econ WHERE
  // offer_id IS NOT NULL GROUP BY org_id, offer_id) -- offer_report_campaign_econ
  // is a plain VIEW, not a matview, so re-deriving it live and comparing still
  // catches what 3a exists to catch (campaigns leaking out of the offer
  // partition, dropped or duplicated offer rows in the totals matview) without
  // depending on when two independently-scheduled matviews last refreshed.
  //
  // What this criterion does NOT do any more: assert footer + null-offer ==
  // offer_report_org_summary_mv's benchmark as a pass/fail. That comparison
  // crosses TWO independently-refreshed matviews with no guaranteed
  // relationship in time. Migration 0132 does not rebuild
  // offer_report_org_summary_mv, so immediately after apply the totals
  // matview is seconds old while the summary matview holds the last cron
  // snapshot -- up to 15h and tens of thousands of sends behind (the cron
  // runs twice daily). Even against a freshly refreshed database the two
  // matviews are rebuilt seconds apart while sends land continuously, so a
  // real, non-zero difference is EXPECTED, not a defect. Asserting exact
  // equality here was itself the mistake this rewrite fixes -- this script's
  // own header warns against exactly this class of mistake. The benchmark is
  // still read and printed below, as INFORMATIONAL context only, clearly
  // separated from the pass/fail tally so it cannot be mistaken for one.
  //
  // Offer count comes from the data, never a hardcoded 21. The row set is the
  // UNION of org_ids across every source queried, not a LEFT JOIN driven off
  // one table -- an org present in offer_report_offer_totals_mv (built fresh
  // by the migration this script gates) but absent from
  // offer_report_campaign_econ's org set would otherwise vanish silently
  // instead of failing loudly. Do not "simplify" this back to a single-table
  // FROM.
  console.log("\n=== 3a. Σ footer == live per-org offer_report_campaign_econ aggregate ===");
  const perOrg = await q(sql`
    WITH ids AS (
      SELECT org_id FROM offer_report_offer_totals_mv
      UNION
      SELECT org_id FROM offer_report_campaign_econ
      UNION
      SELECT org_id FROM offer_report_org_summary_mv
    )
    SELECT
      ids.org_id,
      COALESCE(t.footer_sum, 0)::bigint     AS footer_sum,
      COALESCE(t.offers, 0)::int            AS offers,
      COALESCE(e.econ_offer_sum, 0)::bigint AS econ_offer_sum,
      COALESCE(e.econ_null_sum, 0)::bigint  AS econ_null_sum,
      COALESCE(s.benchmark, 0)::bigint      AS benchmark
    FROM ids
    LEFT JOIN (
      SELECT org_id, sum(sends)::bigint AS footer_sum, count(*)::int AS offers
      FROM offer_report_offer_totals_mv
      GROUP BY org_id
    ) t ON t.org_id = ids.org_id
    LEFT JOIN (
      SELECT org_id,
        sum(sends) FILTER (WHERE offer_id IS NOT NULL)::bigint AS econ_offer_sum,
        sum(sends) FILTER (WHERE offer_id IS NULL)::bigint     AS econ_null_sum
      FROM offer_report_campaign_econ
      GROUP BY org_id
    ) e ON e.org_id = ids.org_id
    LEFT JOIN (
      SELECT org_id, sends AS benchmark FROM offer_report_org_summary_mv
    ) s ON s.org_id = ids.org_id
    ORDER BY ids.org_id
  `);
  console.table(perOrg);
  const totalOffers = perOrg.reduce((sum, r) => sum + n(r.offers), 0);
  assert(totalOffers > 0,
    `totals matview covers ${totalOffers} offers across ${perOrg.length} orgs (asserted from data)`);
  for (const r of perOrg) {
    assert(
      n(r.footer_sum) === n(r.econ_offer_sum),
      `org ${r.org_id}: footer ${r.footer_sum} == live econ offer-scoped sum ${r.econ_offer_sum} ` +
      `(same-snapshot check — offer partition is complete, no leakage/dupes)`,
    );
  }
  console.log("\n  --- below is INFORMATIONAL ONLY, not asserted, cannot fail this script ---");
  for (const r of perOrg) {
    const footerPlusNull = n(r.footer_sum) + n(r.econ_null_sum);
    const diff = n(r.benchmark) - footerPlusNull;
    console.log(`  ℹ org ${r.org_id}: benchmark ${r.benchmark} vs footer+NULL-offer ${footerPlusNull} ` +
                `(diff ${diff}) — offer_report_org_summary_mv and offer_report_offer_totals_mv refresh ` +
                `at different times, so a non-zero diff here is EXPECTED and is NOT a failure.`);
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

  // The migration's header claims the ~4.9% org-wide residual is "sends
  // performed entirely outside the app with a hand-recorded sms_count" — but
  // nothing verifies that. sends - attributable_sends also absorbs tracked
  // campaigns with an EMPTY audience_contact_group_ids (a segment-only
  // audience contributes 100% unattributed, and that column defaults to
  // '{}'), and contacts removed from a group after the send. This decomposes
  // the residual per offer into mutually-exclusive, named buckets so the
  // claim is CHECKABLE rather than taken on faith:
  //   no_per_recipient_rows — the campaign has ZERO stage_sends rows at all
  //     (the "recorded entirely outside the app" case the header names).
  //   non_tracked           — the campaign has stage_sends rows but is not
  //     link_mode='tracked', so offer_report_tracked_campaigns excludes it
  //     wholesale regardless of what those rows contain.
  //   tracked_empty_groups  — tracked, has sent stage_sends rows, but
  //     audience_contact_group_ids is NULL/'{}' (segment-only audience) —
  //     ANY('{}') never matches, so 100% of the campaign is unattributed.
  //   remainder             — tracked, has a non-empty targeted-group list,
  //     and still has some gap: e.g. a contact removed from the group after
  //     the send. Everything else this decomposition doesn't explain lands
  //     here, so a large remainder is the signal something is unaccounted
  //     for, not the three named causes above.
  // Buckets are mutually exclusive per campaign and sum to exactly the same
  // quantity offer_report_offer_totals_mv computes as unattributed_sends (both
  // are sends - attributable_sends over the same campaign set). No assertion
  // here on purpose — a particular split is not something this script should
  // pin; it exists to be read, not to pass or fail.
  console.log("\n=== 3b (decomposition). unattributed_sends by cause, per offer ===");
  const decomposition = await q(sql`
    WITH camp AS (
      SELECT e.org_id, e.offer_id, e.campaign_id, e.sends,
             c.link_mode,
             c.audience_contact_group_ids AS gids,
             EXISTS (
               SELECT 1 FROM stage_sends ss
               JOIN campaign_stages cs ON cs.id = ss.stage_id
               WHERE cs.campaign_id = e.campaign_id AND ss.status = 'sent'
             ) AS has_stage_sends
      FROM offer_report_campaign_econ e
      JOIN campaigns c ON c.id = e.campaign_id
      WHERE e.offer_id IS NOT NULL
    ),
    attributable_by_campaign AS (
      -- EXISTS, not a JOIN to contact_contact_groups: matches the migration's
      -- own attributable CTE exactly. A JOIN here would fan a single
      -- stage_sends row out once per matching group for a contact who
      -- belongs to more than one of the campaign's targeted groups,
      -- overcounting n past camp.sends and driving remainder negative.
      SELECT cs.campaign_id, count(*)::bigint AS n
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN offer_report_tracked_campaigns camp2 ON camp2.id = cs.campaign_id
      WHERE ss.status = 'sent'
        AND EXISTS (
          SELECT 1 FROM contact_contact_groups ccg
          WHERE ccg.contact_id = ss.contact_id
            AND ccg.contact_group_id = ANY(camp2.gids)
            AND ccg.org_id = camp2.org_id
        )
      GROUP BY cs.campaign_id
    ),
    classified AS (
      SELECT camp.offer_id,
        CASE
          WHEN NOT camp.has_stage_sends THEN 'no_per_recipient_rows'
          WHEN camp.link_mode <> 'tracked' THEN 'non_tracked'
          WHEN camp.gids IS NULL OR camp.gids = '{}' THEN 'tracked_empty_groups'
          ELSE 'remainder'
        END AS bucket,
        CASE
          WHEN NOT camp.has_stage_sends THEN camp.sends
          WHEN camp.link_mode <> 'tracked' THEN camp.sends
          WHEN camp.gids IS NULL OR camp.gids = '{}' THEN camp.sends
          ELSE camp.sends - COALESCE(ab.n, 0)
        END AS residual
      FROM camp
      LEFT JOIN attributable_by_campaign ab ON ab.campaign_id = camp.campaign_id
    )
    SELECT offer_id,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'no_per_recipient_rows'), 0)::bigint AS no_per_recipient_rows,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'non_tracked'), 0)::bigint           AS non_tracked,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'tracked_empty_groups'), 0)::bigint  AS tracked_empty_groups,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'remainder'), 0)::bigint             AS remainder,
      sum(residual)::bigint AS total_residual
    FROM classified
    GROUP BY offer_id
    ORDER BY total_residual DESC
  `);
  console.table(decomposition);
  console.log(
    "  Read-only, not asserted. Each offer's total_residual above should equal its\n" +
    "  unattributed_sends in the 3b table above it (both are sends - attributable_sends\n" +
    "  over the same campaign set) — cross-check by eye, the point is that the header's\n" +
    "  claim is now checkable rather than asserted.",
  );

  // ----------------------------------------------------------------- criterion 4
  // Not missing. Criterion 4 is the org-benchmark before/after comparison,
  // which must bracket the migration apply and therefore lives in the plan's
  // Task 8 (snapshot the benchmark immediately before `db:migrate`, re-read it
  // immediately after) — not here. This script runs at a single point in
  // time, so it cannot itself compute a before/after diff.

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

  const summaryLine = `${passed} checks passed, ${failed} failed, ${skipped} SKIPPED`;
  if (failed > 0) {
    console.log(`\n${summaryLine}.`);
  } else if (skipped > 0) {
    console.log(`\n⚠ ${summaryLine} — not a clean pass (${skippedCriteria.join(", ")} skipped, not run).`);
  } else {
    console.log(`\n${summaryLine}. verify-offer-group-attribution OK.`);
  }
  await c.end();
  // Exit code convention, deliberate: automation reads the exit code, not this
  // log text, so a skip must be unmissable to a MACHINE, not just a human
  // reading the output.
  //   0 = clean pass — no failures, nothing skipped.
  //   1 = one or more assertions failed (also used for the expected
  //       pre-migration fail path above, and for an uncaught exception).
  //   2 = no failures, but one or more criteria were SKIPPED — distinct from
  //       0 on purpose, so a skip can never be silently read as a pass by a
  //       script or CI step that only checks "exit code == 0".
  process.exit(failed > 0 ? 1 : skipped > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
