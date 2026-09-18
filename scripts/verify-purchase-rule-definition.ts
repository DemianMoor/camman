import "./_env-preload";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "../db/client";
import { buildSegmentAudienceClause } from "../lib/segment-rules-eval";
import { campaignTierExpr, EXIT_TIER, tierLiteral } from "../lib/campaign-tier";
import {
  legacySaleStatusPurchasedClause,
  purchasedClause,
  registeredClause,
} from "../lib/sale-attribution";
import { seedConversionEvent } from "./_conversion-fixture";

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
//      ⚠️ WORLD-STATE THIS BAR DEPENDS ON: today no registration-typed
//      conversion exists in this account. The legacy definition cannot tell a
//      $0 registration from a purchase (the network posts registrations with a
//      `lead` status, which stamps converted_at), while the ledger correctly
//      does — so the FIRST PsychoBook registration makes the two sides differ
//      for a CORRECT reason. A and E therefore subtract the contacts whose
//      legacy-only buyer-ness is explained by a registration-typed ledger row,
//      and print the registration count so the state is named, not assumed.
//   B. 'rejected' is NOT a purchase — proven on SYNTHESIZED state (there are no
//      rejected rows in prod today), so the bar can actually go red.
//   C. The fix is load-bearing — the OLD predicate is re-run and must produce a
//      STRICTLY SMALLER audience. If the network ever starts sending 'sale' for
//      everything this bar goes quiet-equal, which is reported, not asserted.
//   D. The purchased tier (campaign-tier.ts EXIT_TIER, 4 since Phase 4 — it was
//      3 before Registered joined the scale) is reachable.

// ⚠️ `.env.local` is PRODUCTION and `_env-preload` loads it whenever
// DATABASE_URL is not already set. B synthesizes a 'rejected' conversion — the
// transaction always ROLLBACKs, but a rollback is a promise, not a guarantee
// against an interrupted run, so refuse the production ref outright:
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/verify-purchase-rule-definition.ts
// A/C/E compare LIVE counts, so they are only meaningful against an org that
// actually has sends and conversions — point VERIFY_ORG_ID at one.
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

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

  // ⭐ NAME THE WORLD-STATE these bars are calibrated against. Zero
  // registration-typed ledger rows today; the moment that changes, the legacy
  // definition starts calling registrants buyers and the ledger stops, so A and
  // E below exclude exactly those contacts instead of reading them as drift.
  const registrationRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ${registeredClause()}`);
  const registrationContacts = await scalar(drizzleSql`
    SELECT count(DISTINCT ce.contact_id)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${registeredClause()}`);

  console.log("LIVE CONFIG (reported, not asserted):");
  console.log(`  stage_sends rows           : ${totalSends.toLocaleString()}`);
  console.log(`  rows with a conversion     : ${convRows.toLocaleString()}`);
  console.log(`  status mix                 : ${statusMix
    .map((r) => `${r.s}=${r.n}`)
    .join(", ")}`);
  console.log(`  rejected rows in prod      : ${rejectedRows}`);
  console.log(
    `  registration ledger rows   : ${registrationRows} (${registrationContacts} contacts)` +
      (registrationRows === 0
        ? " — none yet, so the legacy and ledger definitions still line up"
        : " — the legacy definition counts these as buyers; A/E exclude them by name"),
  );
  console.log("");

  // ------------------------------------------------------- A. durable bar
  // Expectation computed live from the REPORTING definition, then narrowed by
  // the two documented differences: rejections are not purchases, and a
  // registration is not a purchase (a registration postback arrives with a
  // `lead` status, so the legacy definition cannot see the difference).
  const driftA = (await db.execute(drizzleSql`
    WITH legacy_reporting AS (
      SELECT DISTINCT ss.contact_id FROM stage_sends ss
      WHERE ss.org_id = ${ORG_ID}::uuid
        AND ss.converted_at IS NOT NULL
        AND COALESCE(ss.sale_status, '') <> 'rejected'
        AND ss.contact_id IS NOT NULL
    ),
    ledger AS (
      SELECT DISTINCT ce.contact_id FROM conversion_events ce
      WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${purchasedClause()}
    ),
    registrants AS (
      SELECT DISTINCT ce.contact_id FROM conversion_events ce
      WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${registeredClause()}
    )
    SELECT (SELECT count(*) FROM legacy_reporting)::int AS legacy_n,
           (SELECT count(*) FROM ledger)::int AS ledger_n,
           (SELECT count(*) FROM (SELECT * FROM legacy_reporting EXCEPT SELECT * FROM ledger) x)::int AS lost,
           -- Parenthesised: INTERSECT binds tighter than EXCEPT in Postgres, so
           -- an unparenthesised chain would mean legacy EXCEPT (ledger INTERSECT
           -- registrants) — a different, much larger set.
           (SELECT count(*) FROM (
              (SELECT * FROM legacy_reporting EXCEPT SELECT * FROM ledger)
              INTERSECT (SELECT * FROM registrants)) y)::int AS lost_explained_by_registration,
           (SELECT count(*) FROM (SELECT * FROM ledger EXCEPT SELECT * FROM legacy_reporting) z)::int AS gained
  `)) as unknown as {
    legacy_n: number;
    ledger_n: number;
    lost: number;
    lost_explained_by_registration: number;
    gained: number;
  }[];
  const dA = driftA[0];
  const ruleBuyers = Number(dA.ledger_n);
  const unexplainedLost = Number(dA.lost) - Number(dA.lost_explained_by_registration);

  console.log("A. Segment definition agrees with the reporting definition");
  console.log(
    `   ledger ${dA.ledger_n} · legacy-reporting ${dA.legacy_n} · legacy-only ${dA.lost}` +
      ` (${dA.lost_explained_by_registration} explained by a registration) · ledger-only ${dA.gained}`,
  );
  check(
    `made_purchase (${ruleBuyers}) loses no contact the reporting definition called a buyer, except registrants`,
    unexplainedLost === 0,
    `${unexplainedLost} legacy buyers are neither ledger buyers nor registrants`,
  );
  check(
    "the ledger adds no contact the reporting definition never counted",
    Number(dA.gained) === 0,
    `${dA.gained} ledger-only buyers — a conversion with no converted_at stamp on its send row`,
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
      // ⭐ THE DONOR IS CHOSEN BY THE LEDGER, not by the legacy columns. The
      // bar below asserts before === 0, i.e. "this contact is not already a
      // buyer" — and "buyer" is now a conversion_events question. Selecting on
      // sale_status could pick a contact who already carries a counted purchase
      // in the ledger, making before === 1 and the bar red for a reason that has
      // nothing to do with rejections. (The row-level sale_status IS NULL is
      // kept only so the legacy UPDATE below isn't overwriting a real value.)
      const donor = (await tx.execute(drizzleSql`
        SELECT ss.id, ss.contact_id, ss.campaign_id, ss.stage_id, ss.phone
        FROM stage_sends ss
        WHERE ss.org_id = ${ORG_ID}::uuid AND ss.sale_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM conversion_events ce
            WHERE ce.org_id = ss.org_id AND ce.contact_id = ss.contact_id
              AND ${purchasedClause()})
        LIMIT 1`)) as unknown as {
        id: string;
        contact_id: string;
      }[];
      if (donor.length === 0) {
        check("found a non-buyer send row to synthesize onto", false);
        throw new Error("rollback");
      }
      const { id, contact_id, campaign_id, stage_id } = donor[0] as {
        id: string;
        contact_id: string;
        campaign_id: number | null;
        stage_id: number | null;
      };

      const before = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM conversion_events ce
        WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id = ${contact_id}::uuid
          AND ce.contact_id IS NOT NULL AND ${purchasedClause()}`,
        tx as never,
      );

      // ⚠️ DEVIATION FROM THE BRIEF, DOCUMENTED: purchasedClause() now reads
      // conversion_events, not stage_sends, so synthesizing the state by
      // UPDATEing stage_sends.sale_status alone (the brief's literal Part B)
      // would no longer move what's being asserted — before/afterRejected would
      // both read 0 for the wrong reason (no ledger row at all), and afterLead
      // would stay 0, failing the "bar can go red" check. Stamp BOTH: the
      // legacy column (still written by lib/keitaro/poll-conversions.ts) and a
      // matching conversion_events row, exactly the pairing every other script
      // in this task's Step 6 uses. Still inside the same rolled-back tx.
      await tx.execute(drizzleSql`
        UPDATE stage_sends
        SET sale_status = 'rejected', sale_revenue = 99.0000, converted_at = now()
        WHERE id = ${id}::uuid`);
      const ceId = await seedConversionEvent(tx, {
        orgId: ORG_ID,
        stageSendId: id,
        contactId: contact_id,
        campaignId: campaign_id,
        stageId: stage_id,
        eventKey: "purchase",
        status: "rejected",
        revenue: 99,
        keitaroType: "rejected",
      });

      const afterRejected = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM conversion_events ce
        WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id = ${contact_id}::uuid
          AND ce.contact_id IS NOT NULL AND ${purchasedClause()}`,
        tx as never,
      );
      check(
        "a 'rejected' conversion does NOT make the contact a buyer",
        before === 0 && afterRejected === 0,
        `before=${before} afterRejected=${afterRejected}`,
      );

      // Same ledger row flipped to approved MUST count — proves the bar above
      // is live and not just an always-zero query.
      await tx.execute(drizzleSql`
        UPDATE stage_sends SET sale_status = 'lead' WHERE id = ${id}::uuid`);
      await tx.execute(drizzleSql`
        UPDATE conversion_events SET status = 'approved' WHERE id = ${ceId}::bigint`);
      const afterLead = await scalar(
        drizzleSql`
        SELECT count(*)::int AS n FROM conversion_events ce
        WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id = ${contact_id}::uuid
          AND ce.contact_id IS NOT NULL AND ${purchasedClause()}`,
        tx as never,
      );
      check(
        "the SAME ledger row flipped to approved DOES make them a buyer (bar can go red)",
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
  console.log(`\nD. campaign-tier tier ${EXIT_TIER} ('purchased', the exit) is reachable`);
  const campRow = (await db.execute(drizzleSql`
    SELECT ce.campaign_id AS id, count(*)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${purchasedClause()}
      AND ce.campaign_id IS NOT NULL
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
      WHERE t.tier = ${tierLiteral(EXIT_TIER)}`);
    check(
      `campaign ${campRow[0].id}: ${tierCount} contacts at tier ${EXIT_TIER} (purchased)`,
      tierCount > 0,
      `tier ${EXIT_TIER} still unreachable`,
    );
  }

  // ⚠️ SAME WORLD-STATE AS A: with zero registration-typed ledger rows the two
  // definitions agree on every contact, so `lost` is expected to be 0. The
  // first PsychoBook registration changes that CORRECTLY — the network posts it
  // with a `lead` status, so the legacy predicate calls that contact a buyer and
  // the ledger does not. Those contacts are subtracted by name below, so a
  // correct future does not read as a regression.
  // ----------------------------------------------- E. ledger vs legacy drift
  console.log("\nE. Ledger buyers vs the legacy sale_status definition (drift)");
  const drift = (await db.execute(drizzleSql`
    WITH ledger AS (
      SELECT DISTINCT ce.contact_id FROM conversion_events ce
      WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${purchasedClause()}
    ),
    legacy AS (
      SELECT DISTINCT ss.contact_id FROM stage_sends ss
      WHERE ss.org_id = ${ORG_ID}::uuid AND ss.contact_id IS NOT NULL
        AND ${legacySaleStatusPurchasedClause()}
    ),
    registrants AS (
      SELECT DISTINCT ce.contact_id FROM conversion_events ce
      WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${registeredClause()}
    )
    SELECT (SELECT count(*) FROM ledger)::int AS ledger_n,
           (SELECT count(*) FROM legacy)::int AS legacy_n,
           (SELECT count(*) FROM (SELECT * FROM legacy EXCEPT SELECT * FROM ledger) x)::int AS lost,
           -- Parenthesised: INTERSECT binds tighter than EXCEPT in Postgres.
           (SELECT count(*) FROM (
              (SELECT * FROM legacy EXCEPT SELECT * FROM ledger)
              INTERSECT (SELECT * FROM registrants)) z)::int AS lost_explained_by_registration,
           (SELECT count(*) FROM (SELECT * FROM ledger EXCEPT SELECT * FROM legacy) y)::int AS gained
  `)) as unknown as {
    ledger_n: number;
    legacy_n: number;
    lost: number;
    lost_explained_by_registration: number;
    gained: number;
  }[];
  console.log(
    `  buyers: ledger ${drift[0].ledger_n} · legacy ${drift[0].legacy_n} · lost ${drift[0].lost}` +
      ` (${drift[0].lost_explained_by_registration} of them are registrants, which is correct)` +
      ` · gained ${drift[0].gained}`,
  );
  const eUnexplained = Number(drift[0].lost) - Number(drift[0].lost_explained_by_registration);
  check(
    "⭐ no contact the legacy definition called a buyer is lost by the ledger, unless it is a registrant",
    eUnexplained === 0,
    `lost=${drift[0].lost}, registration-explained=${drift[0].lost_explained_by_registration}, unexplained=${eUnexplained}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verifier crashed:", err);
  process.exit(1);
});
