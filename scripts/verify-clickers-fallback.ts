// Verifies the Overview "clickers fallback" invariant in
// app/api/keitaro/reports/route.ts: for a link_mode='tracked' stage, when
// Keitaro's visit_clicks_clean reads 0 but CamMan's counted_clickers is > 0,
// the API must display `clickers = counted_clickers` and set
// `clickers_is_fallback = true`. Otherwise it must display the Keitaro
// number with the flag false.
//
// Run: npx tsx scripts/verify-clickers-fallback.ts
//
// ⚠️ WHY THIS WAS REWRITTEN (2026-08-24). The previous version pinned a
// snapshot of live production counts into `.tracking-gap-baseline.json` and
// hardcoded "stage 3029 has 0 Keitaro visits". Both are assertions about the
// MOVING WORLD, not the code under test: a real click took stage 3029's
// counted_clickers from 282 to 283 ("unchanged" failed reporting a write that
// never happened), and the landing page's Keitaro script started firing again
// (0 -> 1 visit, "still 0 visits" failed too) — while the fallback logic was
// correct both times. As every landing page gets fixed, every stage leaves
// the gap state and the old script would fail PERMANENTLY. There is no
// `--baseline` mode any more; nothing is snapshotted to disk.
//
// PART 1 evaluates the rule against live, already-committed data and REPORTS
// the cohort split — informational only, never fails, exactly like
// scripts/verify-tracking-gap.ts's Part 1. It explicitly says so when either
// cohort (in the fallback state / not) is empty, rather than silently passing
// as though it verified something.
// PART 2 synthesizes BOTH cohorts (plus a true-zero edge case) inside a
// rolled-back transaction, so the rule is proven to still catch a regression
// after every live gap closes, regardless of what the world looks like today.
// Mirrors verify-tracking-gap.ts's structure and rollback discipline exactly.
//
// ⚠️ LIMITATION — this does NOT invoke the route's actual code.
// The fallback DECISION (app/api/keitaro/reports/route.ts, search for
// "READ-TIME CLICKERS FALLBACK", ~line 148) is a short loop inline in the GET
// handler and is not exported, so it cannot be imported and called directly.
// Two ways of reaching the real code were considered and ruled out:
//   1. Calling the route's exported GET() directly: it authenticates via
//      requireApiMembership() -> lib/supabase/server.ts -> next/headers
//      cookies(), which requires Next's request-scoped AsyncLocalStorage.
//      Invoking GET() from a plain tsx script (no live Next request) throws
//      "`cookies` was called outside a request scope."
//   2. Hitting the deployed route over HTTP with an authenticated session
//      (the pattern several scripts/test-*-api.ts scripts use): checked by
//      probing https://camman.vercel.app/api/keitaro/reports directly — as
//      of this writing the fallback feature (clickers_is_fallback,
//      migration/feature added on this branch) has NOT been merged to main
//      and is not present in the deployed response at all, so hitting prod
//      would test nothing.
// So `expectedFallback()` below now composes the SHARED, exported no-visits
// predicate — hasNoKeitaroVisits(), imported from lib/reporting/tracking-gap.ts,
// the same function app/api/keitaro/reports/route.ts and the alert both call —
// with the two conditions that remain inline in route.ts and unexported
// (link_mode === 'tracked', counted_clickers > 0). Only those two are still a
// by-hand mirror; the no-visits test itself can no longer drift between this
// script and the route, because both call the same function. The raw INPUTS
// it runs on (visit_clicks_raw/clean, the counted-clickers denominator) ARE
// the real, exported, shared computation the route itself calls —
// lib/reporting/stage-funnel.ts::getStageMetricsInRange — for Part 1's live
// data, which keeps the duplicated surface to just the two remaining
// conditions. getStageMetricsInRange always queries the global `db` singleton
// (no transaction handle), so it cannot see Part 2's synthesized fixtures
// either; Part 2 queries those same raw numbers directly via SQL against `tx`.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
import { hasNoKeitaroVisits } from "@/lib/reporting/tracking-gap";

let fail = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

// Composes the shared hasNoKeitaroVisits() predicate with the two conditions
// that remain inline in route.ts — see the note above.
function expectedFallback(
  linkMode: string,
  visitClicksRaw: number,
  visitClicksClean: number,
  countedClickers: number,
): { clickers: number; clickers_is_fallback: boolean } {
  const isFallback =
    linkMode === "tracked" &&
    hasNoKeitaroVisits(visitClicksRaw, visitClicksClean) &&
    countedClickers > 0;
  return {
    clickers: isFallback ? countedClickers : visitClicksClean,
    clickers_is_fallback: isFallback,
  };
}

async function main() {
  // ── PART 1 — the live picture. Reported, never asserted. ──────────────────
  console.log("\nPART 1 — live findings (informational)\n");

  const orgRows = (await db.execute(
    sql`SELECT id FROM organizations LIMIT 1`,
  )) as unknown as { id: string }[];
  if (orgRows.length === 0) throw new Error("no organizations row found");
  const orgId = orgRows[0].id;

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

  const { stages, clickers } = await getStageMetricsInRange(orgId, from, to);
  const tracked = stages.filter((s) => s.link_mode === "tracked");
  const live = tracked.map((s) => {
    const counted = clickers.periodByStage.get(s.stage_id) ?? 0;
    const visitsRaw = s.tally.visit_clicks_raw;
    const visitsClean = s.tally.visit_clicks_clean;
    return {
      stage_id: s.stage_id,
      visits_raw: visitsRaw,
      visits_clean: visitsClean,
      counted,
      // The pre-FIX-1 rule (clean-only), for the before/after comparison below.
      would_mark_before: visitsClean === 0 && counted > 0,
      ...expectedFallback(s.link_mode, visitsRaw, visitsClean, counted),
    };
  });
  const inFallback = live.filter((r) => r.clickers_is_fallback);
  const notInFallback = live.filter((r) => !r.clickers_is_fallback);
  const wouldMarkBefore = live.filter((r) => r.would_mark_before);
  // Of the stages the old rule would have marked, how many actually had
  // Keitaro traffic (raw > 0) — i.e. were marked WRONGLY.
  const wronglyMarkedBefore = wouldMarkBefore.filter((r) => r.visits_raw > 0);

  console.log(`  evaluated ${live.length} tracked stage(s) over ${from}..${to} (ET)`);
  console.log(`    ${inFallback.length} currently in the fallback state`);
  console.log(`    ${notInFallback.length} currently NOT in the fallback state`);
  console.log(
    `\n  FIX 1 before/after — stages the Overview would mark with '*':\n` +
      `    before (clean-only test):        ${wouldMarkBefore.length}\n` +
      `      of which had raw > 0 (wrong):  ${wronglyMarkedBefore.length}\n` +
      `    after (hasNoKeitaroVisits):       ${inFallback.length}`,
  );

  if (inFallback.length === 0) {
    console.log(
      "    no stages currently in the fallback state; the fallback branch was NOT " +
        "exercised by live data (Part 2 below synthesizes it regardless)",
    );
  } else {
    for (const r of inFallback.slice(0, 10)) {
      console.log(
        `      stage ${r.stage_id}: visits_raw=${r.visits_raw}, visits_clean=${r.visits_clean}, ` +
          `counted_clickers=${r.counted} -> displayed clickers=${r.clickers}`,
      );
    }
  }
  if (notInFallback.length === 0) {
    console.log(
      "    every tracked stage is currently in the fallback state; the non-fallback " +
        "branch was NOT exercised by live data (Part 2 below synthesizes it regardless)",
    );
  }

  // ── PART 2 — the durable invariant. Synthesized, asserted, rolled back. ───
  console.log("\nPART 2 — durable invariant (synthesized, rolled back)\n");

  try {
    await db.transaction(async (tx) => {
      // Pick any real tracked campaign + org so FKs are satisfiable.
      const seed = (await tx.execute(sql`
        SELECT c.id AS campaign_id, c.org_id
        FROM campaigns c
        WHERE c.link_mode = 'tracked'
        ORDER BY c.id DESC
        LIMIT 1
      `)) as unknown as { campaign_id: number; org_id: string }[];
      if (seed.length === 0) throw new Error("no tracked campaign to seed from");
      const { campaign_id, org_id } = seed[0];

      const contactRows = (await tx.execute(sql`
        SELECT id FROM contacts WHERE org_id = ${org_id}::uuid ORDER BY id LIMIT 3
      `)) as unknown as { id: string }[];
      if (contactRows.length < 3) throw new Error("need at least 3 contacts in the seed org");
      const [c1, c2, c3] = contactRows.map((r) => r.id);

      // Four synthetic stages exercising both branches of the rule, the edge
      // case where there is nothing to fall back to, and the FIX 1 regression
      // case:
      //   GAP      — 0 Keitaro visits (raw AND clean), 3 CamMan counted
      //              clickers -> fallback
      //   HEALTHY  — 5 Keitaro visits, 2 CamMan counted clickers (deliberately
      //              LOWER than visits) -> NOT fallback, proving visits>0 wins
      //              even when a different counted value also exists
      //   ZERO     — 0 visits AND 0 counted clickers -> NOT fallback (nothing
      //              to substitute)
      //   RAW_ONLY — raw > 0, clean = 0, 3 CamMan counted clickers -> NOT
      //              fallback. This is the exact shape FIX 1 corrected:
      //              Keitaro's script fired (raw > 0), the visits just
      //              weren't unique, so it must not read as a blackout.
      //              Revert FIX 1's condition (hasNoKeitaroVisits back to
      //              testing clean alone) and this fixture goes red — proof
      //              the assertion is not vacuous.
      const stages = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
        VALUES
          (${org_id}::uuid, ${campaign_id}, 901, 'VERIFY_FALLBACK_GAP_STAGE',      now() - interval '24 hours'),
          (${org_id}::uuid, ${campaign_id}, 902, 'VERIFY_FALLBACK_HEALTHY_STAGE',  now() - interval '24 hours'),
          (${org_id}::uuid, ${campaign_id}, 903, 'VERIFY_FALLBACK_ZERO_STAGE',     now() - interval '24 hours'),
          (${org_id}::uuid, ${campaign_id}, 904, 'VERIFY_FALLBACK_RAWONLY_STAGE',  now() - interval '24 hours')
        RETURNING id, tracking_id
      `)) as unknown as { id: number; tracking_id: string }[];
      const gapStage = stages.find((s) => s.tracking_id === "VERIFY_FALLBACK_GAP_STAGE")!.id;
      const healthyStage = stages.find((s) => s.tracking_id === "VERIFY_FALLBACK_HEALTHY_STAGE")!.id;
      const zeroStage = stages.find((s) => s.tracking_id === "VERIFY_FALLBACK_ZERO_STAGE")!.id;
      const rawOnlyStage = stages.find((s) => s.tracking_id === "VERIFY_FALLBACK_RAWONLY_STAGE")!.id;

      await tx.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date, visit_clicks_raw, visit_clicks_clean)
        VALUES
          (${org_id}::uuid, ${campaign_id}, ${gapStage},     'VERIFY_FALLBACK_GAP_STAGE',     current_date, 0, 0),
          (${org_id}::uuid, ${campaign_id}, ${healthyStage}, 'VERIFY_FALLBACK_HEALTHY_STAGE', current_date, 5, 5),
          (${org_id}::uuid, ${campaign_id}, ${zeroStage},    'VERIFY_FALLBACK_ZERO_STAGE',    current_date, 0, 0),
          (${org_id}::uuid, ${campaign_id}, ${rawOnlyStage}, 'VERIFY_FALLBACK_RAWONLY_STAGE', current_date, 6, 0)
      `);

      // 3 counted_clickers rows on GAP, 2 on HEALTHY, 0 on ZERO, 3 on RAW_ONLY.
      // Reusing c1/c2/c3 across stages is fine — the PK is (stage_id, contact_id).
      await tx.execute(sql`
        INSERT INTO counted_clickers (org_id, campaign_id, stage_id, contact_id, first_click_at)
        VALUES
          (${org_id}::uuid, ${campaign_id}, ${gapStage},     ${c1}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${gapStage},     ${c2}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${gapStage},     ${c3}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${healthyStage}, ${c1}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${healthyStage}, ${c2}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${rawOnlyStage}, ${c1}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${rawOnlyStage}, ${c2}::uuid, now() - interval '1 hour'),
          (${org_id}::uuid, ${campaign_id}, ${rawOnlyStage}, ${c3}::uuid, now() - interval '1 hour')
      `);

      // Read back exactly what route.ts would read: visit_clicks_raw/clean
      // from keitaro_stage_results, counted_clickers counted per stage.
      const results = (await tx.execute(sql`
        SELECT k.stage_id,
               k.visit_clicks_raw AS visits_raw,
               k.visit_clicks_clean AS visits_clean,
               (SELECT count(*)::int FROM counted_clickers cc WHERE cc.stage_id = k.stage_id) AS counted
        FROM keitaro_stage_results k
        WHERE k.stage_id IN (${gapStage}, ${healthyStage}, ${zeroStage}, ${rawOnlyStage})
      `)) as unknown as { stage_id: number; visits_raw: number; visits_clean: number; counted: number }[];
      const byId = new Map(
        results.map((r) => [
          Number(r.stage_id),
          { visitsRaw: Number(r.visits_raw), visitsClean: Number(r.visits_clean), counted: Number(r.counted) },
        ]),
      );
      const gapInputs = byId.get(gapStage)!;
      const healthyInputs = byId.get(healthyStage)!;
      const zeroInputs = byId.get(zeroStage)!;
      const rawOnlyInputs = byId.get(rawOnlyStage)!;

      ok(
        gapInputs.visitsRaw === 0 && gapInputs.visitsClean === 0 && gapInputs.counted === 3,
        "gap fixture: synthesized 0 raw / 0 clean visits, 3 counted clickers",
      );
      const gapExpected = expectedFallback("tracked", gapInputs.visitsRaw, gapInputs.visitsClean, gapInputs.counted);
      ok(gapExpected.clickers_is_fallback === true, "⭐ gap fixture: rule reports clickers_is_fallback = true");
      ok(
        gapExpected.clickers === 3,
        "⭐ gap fixture: rule reports clickers = counted_clickers (3), not the 0 Keitaro visits",
      );

      ok(
        healthyInputs.visitsClean === 5 && healthyInputs.counted === 2,
        "healthy fixture: synthesized 5 visits / 2 counted clickers (counted deliberately LOWER)",
      );
      const healthyExpected = expectedFallback(
        "tracked",
        healthyInputs.visitsRaw,
        healthyInputs.visitsClean,
        healthyInputs.counted,
      );
      ok(healthyExpected.clickers_is_fallback === false, "⭐ healthy fixture: rule reports clickers_is_fallback = false");
      ok(
        healthyExpected.clickers === 5,
        "⭐ healthy fixture: rule reports clickers = the real Keitaro visits (5), NOT counted_clickers (2) — " +
          "proves visits>0 wins even when a smaller counted value also exists",
      );

      ok(
        zeroInputs.visitsRaw === 0 && zeroInputs.visitsClean === 0 && zeroInputs.counted === 0,
        "zero fixture: synthesized 0 visits AND 0 counted clickers",
      );
      const zeroExpected = expectedFallback("tracked", zeroInputs.visitsRaw, zeroInputs.visitsClean, zeroInputs.counted);
      ok(
        zeroExpected.clickers_is_fallback === false,
        "zero fixture: rule does NOT fall back when there is nothing to fall back to",
      );
      ok(zeroExpected.clickers === 0, "zero fixture: displayed clickers stays 0");

      // ── the FIX 1 regression case ──────────────────────────────────────────
      ok(
        rawOnlyInputs.visitsRaw === 6 && rawOnlyInputs.visitsClean === 0 && rawOnlyInputs.counted === 3,
        "raw-only fixture: synthesized 6 raw / 0 clean visits, 3 counted clickers",
      );
      const rawOnlyExpected = expectedFallback(
        "tracked",
        rawOnlyInputs.visitsRaw,
        rawOnlyInputs.visitsClean,
        rawOnlyInputs.counted,
      );
      ok(
        rawOnlyExpected.clickers_is_fallback === false,
        "⭐⭐ raw-only fixture: rule reports clickers_is_fallback = FALSE — raw > 0 means Keitaro's " +
          "script fired; clean = 0 alone must NOT read as a tracking blackout (the FIX 1 bug: this " +
          "would have been `true` under a clean-only test, wrongly substituting counted_clickers " +
          "and marking a working stage with '*')",
      );
      ok(
        rawOnlyExpected.clickers === 0,
        "raw-only fixture: displayed clickers stays the real (0) Keitaro clean count, not counted_clickers",
      );

      // Nothing above is meant to persist.
      throw new Error("__ROLLBACK__");
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__ROLLBACK__") throw err;
    console.log("\n  (transaction rolled back — nothing written)");
  }

  // Prove the rollback actually happened.
  const residue = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaign_stages
    WHERE tracking_id IN (
      'VERIFY_FALLBACK_GAP_STAGE', 'VERIFY_FALLBACK_HEALTHY_STAGE',
      'VERIFY_FALLBACK_ZERO_STAGE', 'VERIFY_FALLBACK_RAWONLY_STAGE'
    )
  `)) as unknown as { n: number }[];
  ok(Number(residue[0].n) === 0, "⭐ residue check: no synthesized rows survived");

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
