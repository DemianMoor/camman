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
