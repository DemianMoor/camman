// Durability guard for the Keitaro tracking-gap monitor.
// Run: npx tsx scripts/verify-tracking-gap.ts
//
// ⚠️ WHY THIS EXISTS. The obvious check — "does it find the 5 lumzen.co stages?"
// — is a countdown, not a guard. The moment the landing page gets its visit
// script back, that assertion goes green-by-absence and stops testing anything.
// So this script does BOTH:
//
//   PART 1 reports the live picture (informational, never fails).
//   PART 2 asserts the DURABLE INVARIANT by synthesizing a gap stage and a
//          healthy stage inside a transaction that is ROLLED BACK, proving the
//          rule can still go red after today's gap closes.
//
// Everything runs inside one rolled-back transaction. Nothing is written.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  formatTrackingGapAlert,
  runTrackingGapMonitor,
  trackingGapBreached,
  TRACKING_GAP_MIN_HUMAN_CLICKS,
} from "@/lib/reporting/tracking-gap";

let fail = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

async function main() {
  // ── PART 1 — the live picture. Reported, never asserted. ──────────────────
  console.log("\nPART 1 — live findings (informational)\n");
  const live = await runTrackingGapMonitor(db);
  console.log(
    `  evaluated ${live.stages_evaluated} stage(s): ` +
      `${live.breaches.length} breaching, ${live.clean_stage_ids.length} clean`,
  );
  for (const b of live.breaches) {
    console.log(
      `    stage ${b.stage_id} (${b.tracking_id}) — ${b.human_clicks} human clicks, ` +
        `${b.redirects} redirects, LP ${b.destination_url}`,
    );
  }
  if (live.breaches.length === 0) {
    console.log("    none — either the landing pages are healthy or nothing sent recently.");
  }

  // Sample alert text, so a formatting regression is visible in the output.
  if (live.breaches.length > 0) {
    console.log("\n  sample alert body:\n");
    console.log(
      formatTrackingGapAlert(live.breaches[0])
        .split("\n")
        .map((l) => `    | ${l}`)
        .join("\n"),
    );
  }

  // ── PART 2 — the durable invariant. Synthesized, asserted, rolled back. ───
  console.log("\nPART 2 — durable invariant (synthesized, rolled back)\n");

  // The pure rule, first — it needs no fixtures and can never rot.
  ok(
    trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 0),
    "a stage at the click floor with ZERO visits is reported",
  );
  ok(
    !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 1),
    "the SAME stage with ONE visit is NOT reported",
  );
  ok(
    !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS - 1, 0),
    "below the click floor is NOT reported",
  );

  // Now the SQL path, against synthesized rows. This is what catches a query that
  // stops matching the rule — a WHERE clause edited, a join dropped, a column
  // renamed by a migration.
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

      const before = await runTrackingGapMonitor(tx);
      const beforeIds = new Set(before.breaches.map((b) => b.stage_id));

      // Two synthetic stages, both sent 24h ago (inside the window, past maturity).
      const stages = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, tracking_id, sent_at)
        VALUES
          (${org_id}::uuid, ${campaign_id}, 901, 'VERIFY_GAP_STAGE',     now() - interval '24 hours'),
          (${org_id}::uuid, ${campaign_id}, 902, 'VERIFY_HEALTHY_STAGE', now() - interval '24 hours')
        RETURNING id, tracking_id
      `)) as unknown as { id: number; tracking_id: string }[];
      const gapStage = stages.find((s) => s.tracking_id === "VERIFY_GAP_STAGE")!.id;
      const healthyStage = stages.find((s) => s.tracking_id === "VERIFY_HEALTHY_STAGE")!.id;

      // The healthy stage gets Keitaro visits; the gap stage gets a row with ZERO
      // visits (proving the monitor keys off the value, not off a missing row).
      await tx.execute(sql`
        INSERT INTO keitaro_stage_results
          (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
           visit_clicks_raw, visit_clicks_clean, redirect_clicks_clean)
        VALUES
          (${org_id}::uuid, ${campaign_id}, ${gapStage},     'VERIFY_GAP_STAGE',     current_date, 0,  0, 7),
          (${org_id}::uuid, ${campaign_id}, ${healthyStage}, 'VERIFY_HEALTHY_STAGE', current_date, 40, 30, 5)
      `);

      // Both stages get the SAME number of human clicks — so the only thing that
      // can distinguish them is the visit count.
      const n = TRACKING_GAP_MIN_HUMAN_CLICKS + 5;
      const dest = (await tx.execute(sql`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${org_id}::uuid, 'https://verify.example/lp', 'verify-tracking-gap-hash')
        RETURNING id
      `)) as unknown as { id: number }[];

      // ⚠️ `links` has TEN NOT NULL columns with no default — verified against
      // information_schema, not guessed: org_id, code, short_domain_id,
      // destination_id, campaign_id, stage_id, contact_id, send_token,
      // campaign_tracking_id, stage_tracking_id. Omitting any of them fails the
      // insert. Seed the FK-bearing ones from real rows.
      const seedRefs = (await tx.execute(sql`
        SELECT (SELECT id FROM short_domains ORDER BY id LIMIT 1) AS short_domain_id,
               (SELECT id FROM contacts ORDER BY id LIMIT 1) AS contact_id
      `)) as unknown as { short_domain_id: number; contact_id: string }[];
      const { short_domain_id, contact_id } = seedRefs[0];

      // One contact, N distinct send_tokens. The unique index is
      // (stage_id, contact_id, send_token), so varying the token is enough and
      // avoids needing N distinct contacts. The monitor counts click ROWS, not
      // distinct contacts, so this does not weaken the assertion.
      for (const stageId of [gapStage, healthyStage]) {
        await tx.execute(sql`
          WITH new_links AS (
            INSERT INTO links (org_id, campaign_id, stage_id, destination_id,
                               short_domain_id, contact_id, code, send_token,
                               campaign_tracking_id, stage_tracking_id)
            SELECT ${org_id}::uuid, ${campaign_id}, ${stageId}, ${dest[0].id},
                   ${short_domain_id}, ${contact_id}::uuid,
                   'vfy' || ${stageId} || '_' || g, 'vfytok' || g,
                   'VERIFY_CAMPAIGN_TRACKING', 'VERIFY_STAGE_TRACKING'
            FROM generate_series(1, ${n}) g
            RETURNING id
          )
          INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
          SELECT ${org_id}::uuid, id, now() - interval '1 hour', 'human', now()
          FROM new_links
        `);
      }

      const after = await runTrackingGapMonitor(tx);
      const gap = after.breaches.find((b) => b.stage_id === gapStage);
      const healthy = after.breaches.find((b) => b.stage_id === healthyStage);

      ok(gap !== undefined, "⭐ SQL path: the synthesized ZERO-VISIT stage IS reported");
      ok(
        healthy === undefined,
        "⭐ SQL path: the synthesized stage WITH visits is NOT reported (same click count)",
      );
      ok(
        gap?.human_clicks === n,
        `SQL path: reports the human-click count (${gap?.human_clicks} === ${n})`,
      );
      ok(
        gap?.redirects === 7,
        `⭐ SQL path: reports redirect_clicks_CLEAN (${gap?.redirects} === 7), not raw+clean`,
      );
      ok(
        gap?.destination_url === "https://verify.example/lp",
        "SQL path: resolves the landing-page URL for a breaching stage",
      );
      ok(
        after.clean_stage_ids.includes(healthyStage),
        "SQL path: the healthy stage is returned as clean, so its latch gets re-armed",
      );
      ok(
        before.stages_evaluated + 2 === after.stages_evaluated,
        "SQL path: both synthesized stages entered the candidate set",
      );
      ok(
        !beforeIds.has(gapStage),
        "sanity: the synthesized gap stage did not exist before this transaction",
      );

      if (gap) {
        const body = formatTrackingGapAlert(gap);
        ok(
          body.startsWith("⚠️ Keitaro tracking gap\n"),
          "alert body opens with the exact briefed heading",
        );
        ok(
          body.includes("Likely cause: LP is missing the Keitaro visit script"),
          "alert body carries the briefed remediation line",
        );
        ok(!/<[a-z/]/i.test(body), "⭐ alert body contains NO markup (notifyTelegram is plain text)");
      }

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
    WHERE tracking_id IN ('VERIFY_GAP_STAGE', 'VERIFY_HEALTHY_STAGE')
  `)) as unknown as { n: number }[];
  ok(Number(residue[0].n) === 0, "⭐ residue check: no synthesized rows survived");

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failed check(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
