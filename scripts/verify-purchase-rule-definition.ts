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

// Verifies the shared purchase definition (lib/sale-attribution.ts) end-to-end
// by running the REAL app code paths — buildSegmentAudienceClause and
// campaignTierExpr — against live data.
//
// ⭐⭐ THIS SCRIPT DELIBERATELY READS PRODUCTION, AND MUST NEVER WRITE TO IT.
// Its whole value is the comparison against real accumulated conversions: A, C
// and E measure the ledger against the legacy `stage_sends` columns on live
// data, and against an empty database they are all trivially 0 == 0. So it is
// NOT given the `PROD_REF` refusal the fixture-seeding scripts carry — refusing
// production here would refuse the only thing it does. (An earlier revision did
// carry that refusal; it was removed on 2026-09-18 because it blocked the
// script's entire purpose.)
//
// The guard is on the WRITE side instead, and it is enforced by Postgres rather
// than by convention: `main()` runs inside ONE transaction that begins with
// `SET TRANSACTION READ ONLY`, so every statement this script issues is checked
// by the server at executor start and any INSERT / UPDATE / DELETE against a
// non-temporary table fails loudly with SQLSTATE 25006 instead of landing. Bar
// B below PROVES that is live rather than assuming it. Do not "helpfully" drop
// the READ ONLY to make some future write work — add that write to a
// fixture-seeding script that carries the production refusal.
//
// Two honest limits of the guard, so nobody over-trusts it:
//   • `buildSegmentAudienceClause` is APP code and issues its own read through
//     the global `db` pool, outside this transaction. It is a plain SELECT over
//     `segments` / `segment_rules`; the read-only contract still holds, but the
//     server-side enforcement does not reach it.
//   • The whole run is one snapshot-holding transaction. It is short (seconds),
//     but do not grow this script into a long crawl against production.
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
//   B. This verifier CANNOT write — a modifying statement is refused by the
//      server. Proven by attempting one, not asserted. (B used to synthesize a
//      'rejected' conversion here to prove "rejected is not a purchase"; that
//      needed a write, so it moved out. The predicate itself is still pinned,
//      on fixtures, by scripts/test-ledger-predicates-db.ts — bars D2 and D5.)
//   C. The fix is load-bearing — the OLD predicate is re-run and must produce a
//      STRICTLY SMALLER audience. If the network ever starts sending 'sale' for
//      everything this bar goes quiet-equal, which is reported, not asserted.
//   D. The purchased tier (campaign-tier.ts EXIT_TIER, 4 since Phase 4 — it was
//      3 before Registered joined the scale) is reachable.

// A/C/E compare LIVE counts, so they are only meaningful against an org that
// actually has sends and conversions — point VERIFY_ORG_ID at one. Against the
// preview database's empty default org they report 0 == 0 and D has no campaign
// to reach; that is an environment, not a regression.
//   npx tsx --conditions=react-server scripts/verify-purchase-rule-definition.ts
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

// ⭐ EVERY HELPER TAKES THE EXECUTOR, AND NONE OF THEM DEFAULTS TO `db`. Two
// reasons, both learned the hard way:
//   • a read issued through the global `db` pool lands on a DIFFERENT
//     connection, so it cannot see the open transaction — which silently turns
//     an in-transaction assertion into a trivial 0 == 0;
//   • and it would also escape the `SET TRANSACTION READ ONLY` above, which is
//     the only thing standing between this script and a write to production.
// A default parameter would make both failures invisible at the call site, so
// there isn't one: omitting the executor is a type error.
type Executor = { execute: (q: never) => Promise<unknown> };

async function countOf(clause: unknown, on: Executor): Promise<number> {
  const rows = (await on.execute(
    drizzleSql`SELECT count(*)::int AS n FROM (${clause as never}) x` as never,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function scalar(q: unknown, on: Executor): Promise<number> {
  const rows = (await on.execute(q as never)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** The read-only transaction, plus the savepoint capability bar B needs. */
type RoTx = Executor & {
  transaction: <T>(fn: (sp: Executor) => Promise<T>) => Promise<T>;
};

async function main(tx: RoTx) {
  console.log(`Org ${ORG_ID}\n`);

  // ---------------------------------------------------------------- context
  const totalSends = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends WHERE org_id = ${ORG_ID}::uuid`, tx);
  const convRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND converted_at IS NOT NULL`, tx);
  const rejectedRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND sale_status = 'rejected'`, tx);
  const statusMix = (await tx.execute(drizzleSql`
    SELECT COALESCE(sale_status, '(null)') AS s, count(*)::int AS n
    FROM stage_sends WHERE org_id = ${ORG_ID}::uuid
    GROUP BY 1 ORDER BY 2 DESC` as never)) as unknown as { s: string; n: number }[];

  // ⭐ NAME THE WORLD-STATE these bars are calibrated against. Zero
  // registration-typed ledger rows today; the moment that changes, the legacy
  // definition starts calling registrants buyers and the ledger stops, so A and
  // E below exclude exactly those contacts instead of reading them as drift.
  const registrationRows = await scalar(drizzleSql`
    SELECT count(*)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ${registeredClause()}`, tx);
  const registrationContacts = await scalar(drizzleSql`
    SELECT count(DISTINCT ce.contact_id)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${registeredClause()}`, tx);

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
  const driftA = (await tx.execute(drizzleSql`
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
  ` as never)) as unknown as {
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
  const purchaseSegs = (await tx.execute(drizzleSql`
    SELECT DISTINCT s.id, s.name FROM segments s
    JOIN segment_rules r ON r.segment_id = s.id
    WHERE s.org_id = ${ORG_ID}::uuid AND r.is_active
      AND r.rule_type IN ('made_purchase','made_purchase_for_brand','made_purchase_for_offer')
    ORDER BY s.id` as never)) as unknown as { id: number; name: string }[];

  console.log(
    `\n   Segments using a purchase rule (real eval path): ${purchaseSegs.length}`,
  );
  for (const s of purchaseSegs) {
    const clause = await buildSegmentAudienceClause(s.id, ORG_ID);
    const n = await countOf(clause, tx);
    console.log(`     [${s.id}] ${s.name}: ${n.toLocaleString()} contacts`);
  }

  // --------------------------------------------- B. this verifier cannot write
  // ⭐ PROVEN, NOT ASSERTED. The guard that makes it safe to point this script
  // at production is `SET TRANSACTION READ ONLY` at the bottom of this file, and
  // a guard nobody exercises is a guard nobody knows is still there. So issue a
  // real modifying statement and require the SERVER to refuse it.
  //
  // ⭐ THE PROBE IS HARMLESS EVEN IF THE GUARD IS GONE: `WHERE false` matches no
  // row, so the cost of a missing READ ONLY is a red bar, not a mutated
  // production row. Postgres raises 25006 in ExecutorStart for any statement
  // that would modify a non-temporary table — before it examines a single row —
  // so the refusal does not depend on a row existing. That matters: this bar is
  // just as live against the empty preview database as against production, and
  // it is NOT an assertion about today's data.
  //
  // ⭐ IT CAN GO RED, both ways. Delete the READ ONLY line and the UPDATE is
  // accepted, no error is raised, and the bar fails naming exactly that.
  //
  // The probe runs inside a SAVEPOINT (drizzle renders a nested transaction as
  // one). Without it the 25006 would abort the WHOLE outer transaction and
  // every bar after this point would die with 25P02 instead of running.
  //
  // (B used to synthesize a rejected conversion here to prove "rejected is not
  // a purchase". That needed a write. The predicate is still pinned, on
  // fixtures, by scripts/test-ledger-predicates-db.ts — bars D2 and D5.)
  console.log("\nB. This verifier CANNOT write (READ ONLY transaction)");
  const writeErr: string | null = await tx
    .transaction(async (sp) => {
      await sp.execute(drizzleSql`
        UPDATE stage_sends SET sale_status = sale_status WHERE false` as never);
      return null as string | null;
    })
    .catch(
      (e: unknown): string | null =>
        (e as { cause?: { code?: string } })?.cause?.code ??
        (e as { code?: string })?.code ??
        `no SQLSTATE: ${(e as Error)?.message}`,
    );
  check(
    "a write issued by this script is REFUSED by the server (SQLSTATE 25006)",
    writeErr === "25006",
    writeErr === null
      ? "the UPDATE was ACCEPTED — the READ ONLY transaction guard is gone"
      : `got ${writeErr}`,
  );

  // ------------------------------------------------ C. the fix is load-bearing
  const oldPredicate = await scalar(drizzleSql`
    SELECT count(DISTINCT contact_id)::int AS n FROM stage_sends
    WHERE org_id = ${ORG_ID}::uuid AND sale_status = 'sale'`, tx);
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
  const campRow = (await tx.execute(drizzleSql`
    SELECT ce.campaign_id AS id, count(*)::int AS n FROM conversion_events ce
    WHERE ce.org_id = ${ORG_ID}::uuid AND ce.contact_id IS NOT NULL AND ${purchasedClause()}
      AND ce.campaign_id IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1` as never)) as unknown as {
    id: number;
    n: number;
  }[];
  if (campRow.length === 0) {
    check("a campaign with conversions exists", false);
  } else {
    const tierCount = await scalar(drizzleSql`
      SELECT count(*)::int AS n
      FROM (${campaignTierExpr(campRow[0].id, ORG_ID)}) t
      WHERE t.tier = ${tierLiteral(EXIT_TIER)}`, tx);
    check(
      `campaign ${campRow[0].id}: ${tierCount} contacts at tier ${EXIT_TIER} (purchased)`,
      tierCount > 0,
      `tier ${EXIT_TIER} still unreachable`,
    );
  }

  // ⚠️ SAME WORLD-STATE AS A: as measured on 2026-09-18 production carried zero
  // registration-typed ledger rows, so the two definitions agreed on every
  // contact and `lost` came out 0. That is a dated observation, not a standing
  // fact. The first PsychoBook registration changes it CORRECTLY — the network
  // posts it with a `lead` status, so the legacy predicate calls that contact a
  // buyer and the ledger does not. Those contacts are subtracted by name below
  // and the counts are printed, so a correct future does not read as a
  // regression and nobody has to trust this comment's date.
  // ----------------------------------------------- E. ledger vs legacy drift
  console.log("\nE. Ledger buyers vs the legacy sale_status definition (drift)");
  const drift = (await tx.execute(drizzleSql`
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
  ` as never)) as unknown as {
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
}

// ⭐ ONE transaction, and `SET TRANSACTION READ ONLY` is its FIRST statement —
// Postgres refuses that form once the transaction has already run a query
// (25001), so it cannot be moved down. From here on the server rejects every
// INSERT / UPDATE / DELETE this script could issue against a real table; bar B
// proves it is doing so.
//
// `process.exit` lives OUT here, after the transaction has closed: exiting from
// inside would abandon an open transaction mid-flight.
db.transaction(async (tx) => {
  await tx.execute(drizzleSql`SET TRANSACTION READ ONLY`);
  await main(tx as never);
})
  .then(() => process.exit(failed > 0 ? 1 : 0))
  .catch((err) => {
    console.error("verifier crashed:", err);
    process.exit(1);
  });
