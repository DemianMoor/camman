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
    // foot_sends reads offer_report_offer_totals_mv (MATERIALIZED, frozen at
    // its last refresh); econ_sends aggregates offer_report_campaign_econ (a
    // plain VIEW, computed LIVE from stage_sends WHERE status='sent'), which
    // keeps growing while production keeps sending. An `===` here would fail
    // the moment anything lands for offer 96 between the matview's refresh
    // and this read (measured 88,536 -> 93,176 in 24h during planning) — the
    // same defect criterion 3a was rewritten to remove; it was missed here.
    // The time-independent direction: the matview is a frozen PREFIX of a
    // monotonically growing live count (sends are never un-sent), so
    // foot_sends <= econ_sends holds no matter how much time elapsed between
    // the two reads. A violation means either data was deleted from what
    // offer_report_campaign_econ reads, or the offer partition leaked (the
    // totals matview counted a send econ does not attribute to offer 96) —
    // both worth failing on, neither explained by ordinary elapsed time.
    const econDelta = n(agg.econ_sends) - n(agg.foot_sends);
    const econDeltaPct = n(agg.foot_sends) > 0 ? (econDelta / n(agg.foot_sends)) * 100 : null;
    console.log(`  ℹ INFORMATIONAL, not asserted: footer ${agg.foot_sends} vs live campaign-grain econ ` +
                `${agg.econ_sends} (delta +${econDelta}, ${econDeltaPct == null ? "n/a" : econDeltaPct.toFixed(3) + "%"}) ` +
                `— sends land continuously between the matview's refresh and this read, so a positive delta is ` +
                `expected, not a failure.`);
    assert(n(agg.foot_sends) <= n(agg.econ_sends),
      `footer ${agg.foot_sends} <= campaign-grain econ ${agg.econ_sends} ` +
      `(frozen prefix of a monotonically growing live count — a violation means deleted data or a leaked partition)`);
    assert(ratio > 1, `column exceeds footer (a multi-group campaign exists): ${ratio.toFixed(3)}x`);
    assert(ratio < 3,
      `overlap factor is plausible (<3x); ~10x means the unnest fan-out survived — got ${ratio.toFixed(3)}x`);
  }

  // --------------------------------------------------------------- criterion 3a
  // offer_report_offer_totals_mv is a MATERIALIZED view — frozen at its last
  // refresh. offer_report_campaign_econ is a plain VIEW — computed LIVE, and
  // its `sends` (stage_sends WHERE status='sent') keeps growing while
  // production keeps sending (measured ~20/min average, 1,400–2,600/min
  // during a send drain). An `===` between a frozen snapshot and a
  // continuously-advancing live count cannot be made correct by swapping in a
  // different live relation to compare against — that was the mistake in an
  // earlier version of this criterion: it removed the dependency on ONE
  // matview's refresh time (by comparing against a plain view) but left the
  // other's, replacing a stale second side with a continuously-advancing one.
  // This script's own header warns against exactly this class of mistake.
  //
  // What actually catches the defects 3a exists to catch — an offer/org row
  // dropped or duplicated in the totals matview, or a campaign leaking across
  // the offer_id partition — without depending on when either side was last
  // computed:
  //   (i)   the (org_id, offer_id) KEY SET of offer_report_offer_totals_mv
  //         equals that of offer_report_campaign_econ WHERE offer_id IS NOT
  //         NULL, checked in BOTH directions. A key set is a structural
  //         property, not a moving count — it does not depend on how many
  //         sends landed since either side was last computed.
  //   (ii)  per org, footer_sum <= the live econ offer-scoped sum. The
  //         matview is a frozen PREFIX of a monotonically growing live count
  //         (sends are never un-sent), so this direction is stable no matter
  //         how much time elapsed between the two reads — unlike `===`,
  //         `<=` does not go stale. A violation means either data was
  //         deleted from what offer_report_campaign_econ reads (sends is not
  //         actually monotonic on this database) or the offer partition
  //         genuinely leaked (the totals matview counted a send
  //         offer_report_campaign_econ does not attribute to that offer) —
  //         both worth failing on, neither explained by ordinary elapsed time.
  //   (iii) no duplicate (org_id, offer_id) keys on the totals matview.
  //
  // The org benchmark (offer_report_org_summary_mv) is still read and printed
  // below as INFORMATIONAL context, clearly separated from the pass/fail
  // tally so it cannot be mistaken for one — it crosses TWO independently-
  // refreshed matviews with no guaranteed relationship in time (migration
  // 0132 does not rebuild offer_report_org_summary_mv, so immediately after
  // apply the totals matview is seconds old while the summary matview holds
  // the last cron snapshot, up to ~15h and tens of thousands of sends
  // behind), so a non-zero diff there is EXPECTED, not a defect.
  //
  // Offer/org set comes from the data, never a hardcoded 21. The row set is
  // the UNION of org_ids across every source queried, not a LEFT JOIN driven
  // off one table — an org present in offer_report_offer_totals_mv (built
  // fresh by the migration this script gates) but absent from
  // offer_report_campaign_econ's org set would otherwise vanish silently
  // instead of failing loudly. Do not "simplify" this back to a single-table
  // FROM.
  console.log("\n=== 3a. offer_report_offer_totals_mv vs live offer_report_campaign_econ: key set + monotonic bound ===");

  const keyDiff = await q(sql`
    SELECT 'totals_only' AS side, t.org_id, t.offer_id
    FROM (SELECT DISTINCT org_id, offer_id FROM offer_report_offer_totals_mv) t
    LEFT JOIN (
      SELECT DISTINCT org_id, offer_id FROM offer_report_campaign_econ WHERE offer_id IS NOT NULL
    ) e ON e.org_id = t.org_id AND e.offer_id = t.offer_id
    WHERE e.org_id IS NULL
    UNION ALL
    SELECT 'econ_only' AS side, e.org_id, e.offer_id
    FROM (SELECT DISTINCT org_id, offer_id FROM offer_report_campaign_econ WHERE offer_id IS NOT NULL) e
    LEFT JOIN (SELECT DISTINCT org_id, offer_id FROM offer_report_offer_totals_mv) t
      ON t.org_id = e.org_id AND t.offer_id = e.offer_id
    WHERE t.org_id IS NULL
    ORDER BY 1, 2, 3
  `);
  if (keyDiff.length > 0) console.table(keyDiff);
  assert(
    keyDiff.length === 0,
    `offer_report_offer_totals_mv and offer_report_campaign_econ(offer_id IS NOT NULL) share the same ` +
    `(org_id, offer_id) key set (${keyDiff.length} mismatched key(s)` +
    (keyDiff.length > 0
      ? `: ${keyDiff.map((k) => `${k.side} org=${k.org_id} offer=${k.offer_id}`).join(", ")}`
      : "") +
    `)`,
  );

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
      n(r.footer_sum) <= n(r.econ_offer_sum),
      `org ${r.org_id}: footer ${r.footer_sum} <= live econ offer-scoped sum ${r.econ_offer_sum} ` +
      `(frozen prefix of a monotonically growing live count — a violation means deleted data or a leaked partition)`,
    );
  }

  const dupes = (await q(sql`
    SELECT count(*)::bigint AS total_rows, count(DISTINCT (org_id, offer_id))::bigint AS distinct_keys
    FROM offer_report_offer_totals_mv
  `))[0];
  assert(
    n(dupes.total_rows) === n(dupes.distinct_keys),
    `offer_report_offer_totals_mv has no duplicate (org_id, offer_id) keys ` +
    `(${dupes.total_rows} rows, ${dupes.distinct_keys} distinct)`,
  );

  console.log("\n  --- below is INFORMATIONAL ONLY, not asserted, cannot fail this script ---");
  for (const r of perOrg) {
    const footerPlusNull = n(r.footer_sum) + n(r.econ_null_sum);
    const benchDiff = n(r.benchmark) - footerPlusNull;
    console.log(`  ℹ org ${r.org_id}: benchmark ${r.benchmark} vs footer+NULL-offer ${footerPlusNull} ` +
                `(diff ${benchDiff}) — offer_report_org_summary_mv and offer_report_offer_totals_mv refresh ` +
                `at different times, so a non-zero diff here is EXPECTED and is NOT a failure.`);
    const econDelta = n(r.econ_offer_sum) - n(r.footer_sum);
    const econDeltaPct = n(r.footer_sum) > 0 ? (econDelta / n(r.footer_sum)) * 100 : null;
    console.log(`  ℹ org ${r.org_id}: footer ${r.footer_sum} vs live econ offer-scoped sum ${r.econ_offer_sum} ` +
                `(delta +${econDelta}, ${econDeltaPct == null ? "n/a" : econDeltaPct.toFixed(3) + "%"}) — sends land ` +
                `continuously between the matview's refresh and this read, so a positive delta is expected, not a failure.`);
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
  //
  // Keyed on (org_id, offer_id), matching criterion 6 below — offer_id alone
  // is not unique across orgs, and grouping by offer_id alone would conflate
  // two different orgs' offer 96 into one row.
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
      SELECT camp.org_id, camp.offer_id,
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
    SELECT org_id, offer_id,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'no_per_recipient_rows'), 0)::bigint AS no_per_recipient_rows,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'non_tracked'), 0)::bigint           AS non_tracked,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'tracked_empty_groups'), 0)::bigint  AS tracked_empty_groups,
      COALESCE(sum(residual) FILTER (WHERE bucket = 'remainder'), 0)::bigint             AS remainder,
      sum(residual)::bigint AS total_residual
    FROM classified
    GROUP BY org_id, offer_id
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
  // Column checks MUST read pg_attribute, not information_schema.columns:
  // information_schema covers ordinary tables and views only and returns ZERO
  // rows for a MATERIALIZED view. Both of these targets are matviews, so the
  // earlier information_schema version made the "these columns are absent"
  // assertion pass vacuously — it could not have failed even if the columns were
  // still there — while the "this column is present" assertion failed always.
  // A check that cannot fail is worse than no check; that is what caught it.
  const mvCols = async (rel: string) =>
    (await q(sql`
      SELECT a.attname AS column_name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE ns.nspname = 'public' AND c.relkind = 'm' AND c.relname = ${rel}
    `)).map((r) => String(r.column_name));

  const groupCols = await mvCols("offer_group_report_mv");
  // Guard the guard: an empty list would make the "absent" assertion vacuous again.
  assert(groupCols.length > 0,
    `offer_group_report_mv is a matview with ${groupCols.length} columns visible ` +
    `(0 would mean this check is inspecting nothing)`);
  const stray = groupCols.filter((c) =>
    ["has_manual_stages", "offer_clicks", "offer_has_manual"].includes(c));
  assert(stray.length === 0,
    `offer_group_report_mv has none of has_manual_stages/offer_clicks/offer_has_manual ` +
    `(found: ${stray.join(", ") || "none"})`);

  const totalsCols = await mvCols("offer_report_offer_totals_mv");
  assert(totalsCols.includes("has_manual_stages"),
    `has_manual_stages moved to the offer-totals matview (its columns: ${totalsCols.join(", ")})`);

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

  // ----------------------------------------------------------------- criterion 7
  // Regression guard for the Fresh pool defect fixed by migration 0133 (see
  // its header and docs/07-conventions.md's "Offer group report" section).
  // 0126 silently replaced Fresh pool's definition — "sendable and never
  // sent THIS offer" — with "no sent row in the last 90 days, across ALL
  // offers, no opt-out filter". 0128 and 0132 each recreated
  // offer_group_report_mv for unrelated reasons and copied the regressed
  // subquery forward without noticing. Both checks below recompute from base
  // tables (contacts/opt_outs/offer_exposures) — re-reading the matview
  // would prove nothing, since the matview's correctness is exactly what is
  // in question.

  // --------------------------------------------------------------- criterion 7a
  // fresh_pool excludes opt-outs and ineligible contacts, and only subtracts
  // exposure to the ROW'S OWN offer. Recomputed using migration 0133's exact
  // shape: sendable = messaging_status='eligible' AND NOT EXISTS a
  // matching opt_outs row; fresh = sendable_per_group MINUS
  // exposed_per_offer_group (subtraction, not a direct per-offer anti-join —
  // the migration's own comment measures the direct form at 45.6s vs 9.4s
  // here; that reasoning is unchanged for this recomputation).
  //
  // What would have to break for this to fire: fresh_pool counting an
  // opted-out or ineligible contact as fresh (0126's actual defect), or
  // fresh_pool failing to subtract — or wrongly subtracting a DIFFERENT
  // offer's — exposure set.
  console.log("\n=== 7a. fresh_pool recomputed from base tables (sendable minus this offer's exposure) ===");
  const freshCheck = await q(sql`
    WITH sendable AS (
      SELECT ccg.contact_group_id AS group_id, ct.org_id, ct.id AS contact_id
      FROM contacts ct
      JOIN contact_contact_groups ccg
        ON ccg.contact_id = ct.id AND ccg.org_id = ct.org_id
      WHERE ct.messaging_status = 'eligible'
        AND NOT EXISTS (
          SELECT 1 FROM opt_outs o
          WHERE o.contact_id = ct.id AND o.org_id = ct.org_id
        )
    ),
    sendable_per_group AS (
      SELECT org_id, group_id, COUNT(*)::bigint AS n FROM sendable GROUP BY org_id, group_id
    ),
    exposed_per_offer_group AS (
      SELECT s.org_id, e.offer_id, s.group_id, COUNT(*)::bigint AS n
      FROM sendable s
      JOIN offer_exposures e ON e.contact_id = s.contact_id
      GROUP BY s.org_id, e.offer_id, s.group_id
    )
    SELECT m.org_id, m.offer_id, m.group_id,
           m.fresh_pool::bigint AS stored,
           (COALESCE(g.n, 0) - COALESCE(x.n, 0))::bigint AS recomputed
    FROM offer_group_report_mv m
    LEFT JOIN sendable_per_group g ON g.org_id = m.org_id AND g.group_id = m.group_id
    LEFT JOIN exposed_per_offer_group x
      ON x.org_id = m.org_id AND x.offer_id = m.offer_id AND x.group_id = m.group_id
  `);
  // Guard the guard: with zero rows the mismatch assert below would pass
  // vacuously (an empty set trivially has no mismatches).
  assert(freshCheck.length > 0,
    `offer_group_report_mv has rows to recompute fresh_pool against (${freshCheck.length})`);
  const freshMismatches = freshCheck.filter((r) => n(r.stored) !== n(r.recomputed));
  if (freshMismatches.length > 0) console.table(freshMismatches.slice(0, 15));
  assert(freshMismatches.length === 0,
    `fresh_pool matches the base-table recomputation on all ${freshCheck.length} rows ` +
    `(${freshMismatches.length} mismatched` +
    (freshMismatches.length > 15 ? ", showing first 15 above" : "") + `)`);

  // --------------------------------------------------------------- criterion 7b
  // fresh_pool is offer-scoped: the same group must be free to read
  // differently under two different offers, since exposure is per-offer.
  // Before the fix every group's fresh_pool was IDENTICAL across every offer
  // it appeared under (count(DISTINCT fresh_pool) = 1 for all 12 groups,
  // measured pre-migration) — the signature of computing fresh_pool with no
  // offer_id join at all. This is the check that makes that shape of defect
  // impossible to reintroduce silently.
  //
  // What would have to break for this to fire: fresh_pool computed without
  // ever joining offer_exposures to offer_id — every group would then read
  // the same number under every offer's report, and this assert catches
  // that directly rather than inferring it from 7a alone (7a can pass on a
  // database where no group happens to span multiple offers).
  console.log("\n=== 7b. fresh_pool is offer-scoped (same group differs across offers) ===");
  const perGroupAcrossOffers = await q(sql`
    SELECT org_id, group_id,
           count(DISTINCT offer_id)::int AS offers_covering,
           count(DISTINCT fresh_pool)::int AS distinct_fresh_pool_values
    FROM offer_group_report_mv
    GROUP BY org_id, group_id
    HAVING count(DISTINCT offer_id) > 1
    ORDER BY offers_covering DESC
  `);
  if (perGroupAcrossOffers.length === 0) {
    skip("criterion 7b", "no group appears under more than one offer on this database " +
      "— offer-scoping cannot be exercised this way here.");
  } else {
    console.table(perGroupAcrossOffers.slice(0, 15));
    const varies = perGroupAcrossOffers.filter((r) => n(r.distinct_fresh_pool_values) > 1);
    assert(varies.length > 0,
      `at least one multi-offer group's fresh_pool differs across offers ` +
      `(${varies.length} of ${perGroupAcrossOffers.length} multi-offer groups vary; ` +
      `all reading identical is the pre-0133 signature)`);
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
