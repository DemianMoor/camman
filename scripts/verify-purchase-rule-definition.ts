import "./_env-preload";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "../db/client";
import { buildSegmentAudienceClause } from "../lib/segment-rules-eval";
import { campaignTierExpr } from "../lib/campaign-tier";
import { purchasedClause } from "../lib/sale-attribution";

// Verifies the shared purchase definition (lib/sale-attribution.ts) end-to-end
// by running the REAL app code paths — buildSegmentAudienceClause and
// campaignTierExpr — against live data. Read-only: the one write (a synthesized
// 'rejected' conversion) happens inside a transaction that always ROLLBACKs.
//
// WHAT THIS ASSERTS, and why each bar is shaped this way:
//   A. The durable invariant — the segment rule agrees with the REPORTING
//      definition of a sale (rollup.ts: converted_at IS NOT NULL), minus
//      rejections. This is stated as an equality against a live-computed
//      expectation, NOT a hardcoded count, so it stays meaningful as sales
//      accumulate.
//   B. 'rejected' is NOT a purchase — proven on SYNTHESIZED state (there are no
//      rejected rows in prod today), so the bar can actually go red.
//   C. The fix is load-bearing — the OLD predicate is re-run and must produce a
//      STRICTLY SMALLER audience. If the network ever starts sending 'sale' for
//      everything this bar goes quiet-equal, which is reported, not asserted.
//   D. The converted tier (campaign-tier.ts tier 3) is reachable.

const ORG_ID = process.env.VERIFY_ORG_ID ?? "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function countOf(clause: unknown): Promise<number> {
  const rows = (await db.execute(
    drizzleSql`SELECT count(*)::int AS n FROM (${clause as never}) x`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

// MUST take the executor: reads issued through the global `db` pool land on a
// DIFFERENT connection and cannot see an open transaction's uncommitted rows —
// which silently turns every in-transaction assertion into a trivial 0 == 0.
type Executor = { execute: (q: never) => Promise<unknown> };
async function scalar(q: unknown, on: Executor = db as never): Promise<number> {
  const rows = (await on.execute(q as never)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  console.log(`Org ${ORG_ID}\n`);

  // ---------------------------------------------------------------- context
  const totalSends = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends WHERE org_id = ${ORG_ID}::uuid`);
  const convRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND converted_at IS NOT NULL`);
  const rejectedRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND sale_status = 'rejected'`);
  const statusMix = (await db.execute(drizzleSql`
    SELECT COALESCE(sale_status, '(null)') AS s, count(*)::int AS n
    FROM stage_sends WHERE org_id = ${ORG_ID}::uuid
    GROUP BY 1 ORDER BY 2 DESC`)) as unknown as { s: string; n: number }[];

  console.log("LIVE CONFIG (reported, not asserted):");
  console.log(`  stage_sends rows           : ${totalSends.toLocaleString()}`);
  console.log(`  rows with a conversion     : ${convRows.toLocaleString()}`);
  console.log(`  status mix                 : ${statusMix
    .map((r) => `${r.s}=${r.n}`)
    .join(", ")}`);
  console.log(`  rejected rows in prod      : ${rejectedRows}\n`);

  // ------------------------------------------------------- A. durable bar
  // Expectation computed live from the REPORTING definition, then narrowed by
  // the one documented difference (rejections are not purchases).
  const expectedBuyers = await scalar(drizzleSql`
    SELECT count(DISTINCT contact_id)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid
      AND converted_at IS NOT NULL
      AND COALESCE(sale_status, '') <> 'rejected'`);

  const ruleBuyers = await scalar(drizzleSql`
    SELECT count(DISTINCT ss.contact_id)::int AS n FROM stage_sends ss
    WHERE ss.org_id = ${ORG_ID}::uuid AND ${purchasedClause()}`);

  console.log("A. Segment definition agrees with the reporting definition");
  check(
    `made_purchase (${ruleBuyers}) == non-rejected conversions (${expectedBuyers})`,
    ruleBuyers === expectedBuyers,
    `drift of ${Math.abs(ruleBuyers - expectedBuyers)} contacts`,
  );

  // Run the REAL segment eval for every segment that uses a purchase rule.
  const purchaseSegs = (await db.execute(drizzleSql`
    SELECT DISTINCT s.id, s.name FROM segments s
    JOIN segment_rules r ON r.segment_id = s.id
    WHERE s.org_id = ${ORG_ID}::uuid AND r.is_active
      AND r.rule_type IN ('made_purchase','made_purchase_for_brand','made_purchase_for_offer')
    ORDER BY s.id`)) as unknown as { id: number; name: string }[];

  console.log(
    `\n   Segments using a purchase rule (real eval path): ${purchaseSegs.length}`,
  );
  for (const s of purchaseSegs) {
    const clause = await buildSegmentAudienceClause(s.id, ORG_ID);
    const n = await countOf(clause);
    console.log(`     [${s.id}] ${s.name}: ${n.toLocaleString()} contacts`);
  }

  // ------------------------------------------- B. rejected is not a purchase
  // Synthesized, so this bar can genuinely go red. Always rolled back.
  console.log("\nB. 'rejected' is NOT a purchase (synthesized, rolled back)");
  await db
    .transaction(async (tx) => {
      const donor = (await tx.execute(drizzleSql`
        SELECT ss.id, ss.contact_id, ss.campaign_id, ss.stage_id, ss.phone
        FROM stage_sends ss
        WHERE ss.org_id = ${ORG_ID}::uuid AND ss.sale_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stage_sends o
            WHERE o.org_id = ss.org_id AND o.contact_id = ss.contact_id
              AND o.sale_status IS NOT NULL)
        LIMIT 1`)) as unknown as {
        id: string;
        contact_id: string;
      }[];
      if (donor.length === 0) {
        check("found a non-buyer send row to synthesize onto", false);
        throw new Error("rollback");
      }
      const { id, contact_id } = donor[0];

      const before = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM stage_sends ss
        WHERE ss.org_id = ${ORG_ID}::uuid AND ss.contact_id = ${contact_id}::uuid
          AND ${purchasedClause()}`,
        tx as never,
      );

      // Stamp it REJECTED with revenue — the shape a refund/chargeback takes.
      await tx.execute(drizzleSql`
        UPDATE stage_sends
        SET sale_status = 'rejected', sale_revenue = 99.0000, converted_at = now()
        WHERE id = ${id}::uuid`);

      const afterRejected = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM stage_sends ss
        WHERE ss.org_id = ${ORG_ID}::uuid AND ss.contact_id = ${contact_id}::uuid
          AND ${purchasedClause()}`,
        tx as never,
      );
      check(
        "a 'rejected' conversion does NOT make the contact a buyer",
        before === 0 && afterRejected === 0,
        `before=${before} afterRejected=${afterRejected}`,
      );

      // Same row flipped to 'lead' MUST count — proves the bar above is live
      // and not just an always-zero query.
      await tx.execute(drizzleSql`
        UPDATE stage_sends SET sale_status = 'lead' WHERE id = ${id}::uuid`);
      const afterLead = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM stage_sends ss
        WHERE ss.org_id = ${ORG_ID}::uuid AND ss.contact_id = ${contact_id}::uuid
          AND ${purchasedClause()}`,
        tx as never,
      );
      check(
        "the SAME row flipped to 'lead' DOES make them a buyer (bar can go red)",
        afterLead === 1,
        `afterLead=${afterLead}`,
      );

      throw new Error("rollback");
    })
    .catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });

  const rejectedAfter = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND sale_status = 'rejected'`);
  check(
    "synthesized state was rolled back (prod untouched)",
    rejectedAfter === rejectedRows,
    `rejected rows now ${rejectedAfter}, was ${rejectedRows}`,
  );

  // ------------------------------------------------ C. the fix is load-bearing
  const oldPredicate = await scalar(drizzleSql`
    SELECT count(DISTINCT contact_id)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND sale_status = 'sale'`);
  console.log("\nC. The change is load-bearing");
  console.log(
    `   old predicate (= 'sale'): ${oldPredicate} buyers · new: ${ruleBuyers} buyers`,
  );
  check(
    "new definition finds strictly MORE buyers than the old one",
    ruleBuyers > oldPredicate,
    `old=${oldPredicate} new=${ruleBuyers} — if equal, the network started sending 'sale'`,
  );

  // --------------------------------------------- D. converted tier reachable
  console.log("\nD. campaign-tier tier 3 ('converted') is reachable");
  const campRow = (await db.execute(drizzleSql`
    SELECT ss.campaign_id AS id, count(*)::int AS n FROM stage_sends ss
    WHERE ss.org_id = ${ORG_ID}::uuid AND ${purchasedClause()}
      AND ss.campaign_id IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)) as unknown as {
    id: number;
    n: number;
  }[];
  if (campRow.length === 0) {
    check("a campaign with conversions exists", false);
  } else {
    const tierCount = await scalar(drizzleSql`
      SELECT count(*)::int AS n
      FROM (${campaignTierExpr(campRow[0].id, ORG_ID)}) t
      WHERE t.tier = 3`);
    check(
      `campaign ${campRow[0].id}: ${tierCount} contacts at tier 3 (converted)`,
      tierCount > 0,
      "tier 3 still unreachable",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verifier crashed:", err);
  process.exit(1);
});
