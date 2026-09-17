import "./_env-preload";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  approvedRevenueClause,
  purchasedClause,
  rescueSendIds,
} from "@/lib/sale-attribution";

// Phase 3 Task 4 red/green proof: each per-recipient READER this task switched
// (partner report `purchases` CTE, the by-group `sale` weight basis, the hourly
// sales/revenue pair, Rule F's rescue, the dormant rollup's `conv_sends` CTE) run
// through the REAL query shape copied from its file, against a ONE-SIDED fixture
// set. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-p3-task4-reader-switch-db.ts
//
// Every fixture writes the ledger row and the legacy stage_sends columns
// SEPARATELY, never together, so a check can only pass against the switched
// (ledger-reading) query:
//   • ledger_only      conversion_events purchase (approved, $42), sale_status/
//                       sale_revenue/converted_at all NULL on the send
//   • legacy_only       sale_status='lead', sale_revenue=$100, converted_at=now(),
//                       NO conversion_events row at all
//   • rejected_ledger   conversion_events purchase (status='rejected', $77) +
//                       converted_at=now() on the send (what the old poller did
//                       unconditionally on ANY conversion, rejected or not)
//
// Each block below runs the NEW (ledger) query and the OLD (legacy column)
// query against the identical fixture rows and asserts they DISAGREE in the
// specific way the switch predicts — which is the "red proof": the OLD query's
// numbers are what pre-switch code would have produced for these exact rows,
// and they are wrong (miss a real purchase, count a non-purchase, rescue a
// rejected conversion).

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

class Rollback extends Error {}

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "";
  const host = ref === PREVIEW_REF ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  let sawTx = false;
  try {
    await db.transaction(async (tx: Tx) => {
      sawTx = true;
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0]?.id;
      if (!orgId) throw new Error("no organization on the preview DB");

      const purchaseTypeId = Number(
        (
          (await tx.execute(sql`
            SELECT id FROM event_types WHERE org_id = ${orgId}::uuid AND key = 'purchase'
          `)) as unknown as { id: number }[]
        )[0]?.id,
      );
      check("S0 the 0181 'purchase' event type is seeded on this org", Number.isFinite(purchaseTypeId));
      if (!Number.isFinite(purchaseTypeId)) throw new Rollback();

      const tag = `p3t4-${Date.now()}`;
      const campId = Number(
        (
          (await tx.execute(sql`
            INSERT INTO campaigns (org_id, slug, name, status)
            VALUES (${orgId}::uuid, ${tag}, ${`${tag} camp`}, 'draft')
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );
      const stageId = Number(
        (
          (await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
            VALUES (${orgId}::uuid, ${campId}::int, 1)
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );

      const roles = ["ledger_only", "legacy_only", "rejected_ledger"] as const;
      const cid: Record<string, string> = {};
      for (const [i, role] of roles.entries()) {
        const phone = `+1213${String(Date.now()).slice(-6)}${i}`;
        cid[role] = (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone})
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
      }

      async function send(role: string, legacy: boolean): Promise<string> {
        return (
          (await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
               sent_at, sale_status, sale_revenue, converted_at)
            VALUES (${orgId}::uuid, ${campId}::int, ${stageId}::int, ${cid[role]}::uuid,
                    ${`+1${role}`}, 'probe', 'sent', now(),
                    ${legacy ? "lead" : null},
                    ${legacy ? "100.0000" : null}::numeric,
                    ${legacy ? sql`now()` : sql`NULL`})
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
      }

      const sLedgerOnly = await send("ledger_only", false);
      const sLegacyOnly = await send("legacy_only", true);
      // The rejected fixture: converted_at set (old poller wrote it unconditionally
      // on any conversion), but NO sale_status/sale_revenue — a rejected conversion
      // never carries a payout, so the old poller never stamped sale_status='sale'
      // for it either (poll-conversions.ts maps rejected -> no sale_status write).
      const sRejected = (
        (await tx.execute(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
             sent_at, sale_status, sale_revenue, converted_at)
          VALUES (${orgId}::uuid, ${campId}::int, ${stageId}::int, ${cid.rejected_ledger}::uuid,
                  '+1rejected_ledger', 'probe', 'sent', now(), NULL, NULL, now())
          RETURNING id::text AS id
        `)) as unknown as { id: string }[]
      )[0].id;

      const mkEvent = async (stageSendId: string, status: string, revenue: string) => {
        await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status,
             revenue, occurred_at, stage_send_id, contact_id, campaign_id, stage_id)
          VALUES (${orgId}::uuid, ${`${tag}-${stageSendId}`}, 'lead', 'lead', ${purchaseTypeId}, ${status},
                  ${revenue}::numeric, now(), ${stageSendId}::uuid, NULL, ${campId}::int, ${stageId}::int)
        `);
      };
      await mkEvent(sLedgerOnly, "approved", "42.0000");
      await mkEvent(sRejected, "rejected", "77.0000");

      const ids = [sLedgerOnly, sLegacyOnly, sRejected];
      const idsArr = sql`ARRAY[${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}]::uuid[]`;

      // ── A. partner-report.ts `purchases` CTE / rollup.ts `conv_sends` CTE ──
      // Byte-identical shape (both COUNT purchasedClause + SUM approvedRevenueClause
      // FILTERed, GROUP BY stage_send_id) — tested once, since both call sites are
      // literal copies of the same aggregation over the same predicates.
      console.log("\nA. purchases-by-send CTE (partner-report.ts / rollup.ts conv_sends)");
      const newAgg = (await tx.execute(sql`
        SELECT ce.stage_send_id::text AS id,
               count(*) FILTER (WHERE ${purchasedClause()})::int AS purchases,
               coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::float8 AS revenue
        FROM conversion_events ce
        WHERE ce.org_id = ${orgId}::uuid AND ce.stage_send_id = ANY(${idsArr})
        GROUP BY 1
      `)) as unknown as { id: string; purchases: number; revenue: number }[];
      const newBySend = new Map(newAgg.map((r) => [r.id, r]));
      check(
        "A1 ⭐ NEW: ledger_only counted as 1 purchase / $42 revenue",
        newBySend.get(sLedgerOnly)?.purchases === 1 && Number(newBySend.get(sLedgerOnly)?.revenue) === 42,
        JSON.stringify(newBySend.get(sLedgerOnly)),
      );
      check(
        "A2 ⭐ NEW: legacy_only has NO ledger row at all — absent from the aggregate",
        !newBySend.has(sLegacyOnly),
      );
      check(
        "A3 ⭐ NEW: rejected_ledger contributes 0 purchases and $0 revenue",
        (newBySend.get(sRejected)?.purchases ?? 0) === 0 && Number(newBySend.get(sRejected)?.revenue ?? 0) === 0,
        JSON.stringify(newBySend.get(sRejected)),
      );

      const oldAgg = (await tx.execute(sql`
        SELECT ss.id::text AS id,
               (coalesce(ss.sale_status IN ('lead', 'sale'), false))::int AS purchased,
               coalesce(ss.sale_revenue, 0)::float8 AS revenue
        FROM stage_sends ss
        WHERE ss.id = ANY(${idsArr})
      `)) as unknown as { id: string; purchased: number; revenue: number }[];
      const oldBySend = new Map(oldAgg.map((r) => [r.id, r]));
      check(
        "A4 ⭐ RED PROOF — OLD (pre-switch) code would have MISSED the real $42 purchase (sale_status is NULL on ledger_only)",
        oldBySend.get(sLedgerOnly)?.purchased === 0,
        JSON.stringify(oldBySend.get(sLedgerOnly)),
      );
      check(
        "A5 ⭐ RED PROOF — OLD code would have WRONGLY counted legacy_only as a $100 sale (no ledger backs it)",
        oldBySend.get(sLegacyOnly)?.purchased === 1 && Number(oldBySend.get(sLegacyOnly)?.revenue) === 100,
        JSON.stringify(oldBySend.get(sLegacyOnly)),
      );

      // ── B. performance-report.ts trackedWeights `sale` basis ──────────────
      console.log("\nB. trackedWeights sale-basis candidate set (performance-report.ts)");
      const newCand = (await tx.execute(sql`
        SELECT DISTINCT ss.id::text AS send_id
        FROM conversion_events ce
        JOIN stage_sends ss ON ss.id = ce.stage_send_id
        WHERE ce.org_id = ${orgId}::uuid
          AND ${purchasedClause()}
          AND ss.stage_id = ${stageId}::int
      `)) as unknown as { send_id: string }[];
      const newCandSet = new Set(newCand.map((r) => r.send_id));
      check("B1 ⭐ NEW: ledger_only IS in the sale-basis candidate set", newCandSet.has(sLedgerOnly));
      check("B2 ⭐ NEW: legacy_only is NOT in the candidate set", !newCandSet.has(sLegacyOnly));
      check("B3 ⭐ NEW: rejected_ledger is NOT in the candidate set", !newCandSet.has(sRejected));

      const oldCand = (await tx.execute(sql`
        SELECT ss.id::text AS send_id FROM stage_sends ss
        WHERE ss.org_id = ${orgId}::uuid AND ss.converted_at IS NOT NULL AND ss.stage_id = ${stageId}::int
      `)) as unknown as { send_id: string }[];
      const oldCandSet = new Set(oldCand.map((r) => r.send_id));
      check(
        "B4 ⭐ RED PROOF — OLD basis (ss.converted_at IS NOT NULL) would have MISSED ledger_only entirely",
        !oldCandSet.has(sLedgerOnly),
      );
      check(
        "B5 ⭐ RED PROOF — OLD basis would have WRONGLY included legacy_only (converted_at set, no real purchase)",
        oldCandSet.has(sLegacyOnly),
      );
      check(
        "B6 ⭐ RED PROOF — OLD basis would have WRONGLY included rejected_ledger too",
        oldCandSet.has(sRejected),
      );

      // ── C. Rule F rescue (counted-clickers.ts, via rescueSendIds) ─────────
      console.log("\nC. Rule F rescue set (rescueSendIds, cross-org null variant)");
      const rescued = (await tx.execute(sql`${rescueSendIds(null)}`)) as unknown as {
        stage_send_id: string;
        first_event_at: string;
      }[];
      const rescuedSet = new Set(rescued.map((r) => r.stage_send_id));
      check("C1 ⭐ NEW: ledger_only IS rescued (a counted purchase)", rescuedSet.has(sLedgerOnly));
      check("C2 ⭐ NEW: legacy_only is NOT rescued (no ledger row)", !rescuedSet.has(sLegacyOnly));
      check(
        "C3 ⭐ NEW: rejected_ledger is NOT rescued — Rule F never rescues a rejected conversion",
        !rescuedSet.has(sRejected),
      );
      const oldRescued = (await tx.execute(sql`
        SELECT ss.id::text AS send_id FROM stage_sends ss WHERE ss.converted_at IS NOT NULL AND ss.id = ANY(${idsArr})
      `)) as unknown as { send_id: string }[];
      const oldRescuedSet = new Set(oldRescued.map((r) => r.send_id));
      check(
        "C4 ⭐ RED PROOF — OLD rescue (ss.converted_at IS NOT NULL) would have MISSED ledger_only",
        !oldRescuedSet.has(sLedgerOnly),
      );
      check(
        "C5 ⭐ RED PROOF — OLD rescue would have WRONGLY rescued rejected_ledger — exactly the bug this task fixes",
        oldRescuedSet.has(sRejected),
      );

      // ── D. getHourlyReport ledgerHourAgg (performance-report.ts) ──────────
      console.log("\nD. hourly sales/revenue pair (ledgerHourAgg)");
      const hourly = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE ${purchasedClause()})::int AS sales,
               coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::float8 AS revenue
        FROM conversion_events ce
        JOIN campaign_stages cs ON cs.id = ce.stage_id
        WHERE ce.org_id = ${orgId}::uuid AND ce.stage_send_id = ANY(${idsArr})
      `)) as unknown as { sales: number; revenue: number }[];
      check(
        "D1 ⭐ NEW: hourly sales=1, revenue=$42 across the fixture set (ledger_only only)",
        hourly[0].sales === 1 && Number(hourly[0].revenue) === 42,
        JSON.stringify(hourly[0]),
      );
      const oldHourly = (await tx.execute(sql`
        SELECT count(*)::int AS sales, coalesce(sum(ss.sale_revenue), 0)::float8 AS revenue
        FROM stage_sends ss WHERE ss.converted_at IS NOT NULL AND ss.id = ANY(${idsArr})
      `)) as unknown as { sales: number; revenue: number }[];
      check(
        "D2 ⭐ RED PROOF — OLD hourly (ss.converted_at/sale_revenue) reads sales=2, revenue=$100 — wrong on both counts",
        oldHourly[0].sales === 2 && Number(oldHourly[0].revenue) === 100,
        JSON.stringify(oldHourly[0]),
      );

      // ── E. campaign-activity badge LATERAL (activity/messages/route.ts) ───
      console.log("\nE. campaign-activity badge LATERAL join");
      const badge = (await tx.execute(sql`
        SELECT ss.id::text AS id, conv.event_label, conv.status, conv.revenue
        FROM stage_sends ss
        LEFT JOIN LATERAL (
          SELECT coalesce(et.label, ce.keitaro_type) AS event_label,
                 ce.status AS status,
                 ce.revenue::text AS revenue
          FROM conversion_events ce
          LEFT JOIN event_types et ON et.id = ce.event_type_id
          WHERE ce.stage_send_id = ss.id
          ORDER BY ce.occurred_at DESC, ce.id DESC
          LIMIT 1
        ) conv ON true
        WHERE ss.id = ANY(${idsArr})
      `)) as unknown as { id: string; event_label: string | null; status: string | null; revenue: string | null }[];
      const badgeBySend = new Map(badge.map((r) => [r.id, r]));
      check(
        "E1 ⭐ NEW: ledger_only shows a badge (event_label set, status approved, $42)",
        badgeBySend.get(sLedgerOnly)?.event_label != null &&
          badgeBySend.get(sLedgerOnly)?.status === "approved" &&
          Number(badgeBySend.get(sLedgerOnly)?.revenue) === 42,
        JSON.stringify(badgeBySend.get(sLedgerOnly)),
      );
      check(
        "E2 ⭐ NEW: legacy_only shows NO badge — the ledger has nothing for this send",
        badgeBySend.get(sLegacyOnly)?.event_label == null,
        JSON.stringify(badgeBySend.get(sLegacyOnly)),
      );
      check(
        "E3 ⭐ NEW: rejected_ledger shows a badge with status='rejected', not the old 'lead · $0.00' misread",
        badgeBySend.get(sRejected)?.event_label != null && badgeBySend.get(sRejected)?.status === "rejected",
        JSON.stringify(badgeBySend.get(sRejected)),
      );
      const oldBadge = (await tx.execute(sql`
        SELECT ss.id::text AS id, ss.sale_status, ss.sale_revenue
        FROM stage_sends ss WHERE ss.id = ANY(${idsArr})
      `)) as unknown as { id: string; sale_status: string | null; sale_revenue: string | null }[];
      const oldBadgeBySend = new Map(oldBadge.map((r) => [r.id, r]));
      check(
        "E4 ⭐ RED PROOF — OLD badge (ss.sale_status) shows NOTHING for ledger_only's real $42 purchase",
        oldBadgeBySend.get(sLedgerOnly)?.sale_status == null,
        JSON.stringify(oldBadgeBySend.get(sLedgerOnly)),
      );
      check(
        "E5 ⭐ RED PROOF — OLD badge would have WRONGLY shown legacy_only as 'lead · $100.00'",
        oldBadgeBySend.get(sLegacyOnly)?.sale_status === "lead" &&
          Number(oldBadgeBySend.get(sLegacyOnly)?.sale_revenue) === 100,
        JSON.stringify(oldBadgeBySend.get(sLegacyOnly)),
      );

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  check("Z1 the fixture transaction ran and rolled back", sawTx);

  console.log(`\n${passed} passed, ${failed} failed  (transaction rolled back)`);
  await pgConn.end({ timeout: 5 });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
