import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";

import { db } from "../db/client";
import {
  approvedRevenueClause,
  pendingRevenueClause,
  purchasedClause,
  purchasedSendIds,
  registeredClause,
  rescueSendIds,
} from "../lib/sale-attribution";

// The shared predicates, run through the REAL exported functions against real
// rows, inside a transaction that ALWAYS rolls back. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-ledger-predicates-db.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
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

// With seq scans penalised, a predicate that the named index cannot answer falls
// back to a seq scan and the index name is absent from the plan.
async function usesIndex(tx: Tx, query: SQL, index: string): Promise<boolean> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  const plan = await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  await tx.execute(sql`SET LOCAL enable_seqscan = on`);
  return JSON.stringify(plan).includes(index);
}

class Rollback extends Error {}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0]?.id;
      if (!orgId) throw new Error("no organization on the preview DB");

      const typeIds = (await tx.execute(sql`
        SELECT key, id FROM event_types WHERE org_id = ${orgId}::uuid AND key IN ('purchase', 'registration')
      `)) as unknown as { key: string; id: number }[];
      const purchaseTypeId = typeIds.find((t) => t.key === "purchase")?.id;
      const registrationTypeId = typeIds.find((t) => t.key === "registration")?.id;
      check("D0 the 0181 event types are seeded on this org", purchaseTypeId != null && registrationTypeId != null);
      if (purchaseTypeId == null || registrationTypeId == null) throw new Rollback();

      // Six synthetic ledger rows, no attribution needed beyond the ids we set.
      const tag = `t3-${Date.now()}`;
      const mk = async (
        suffix: string,
        eventTypeId: number | null,
        status: string | null,
        revenue: string,
        stageSendId: string | null,
      ) => {
        const rows = (await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status,
             revenue, occurred_at, contact_id, campaign_id, stage_send_id)
          VALUES (${orgId}::uuid, ${`${tag}-${suffix}`}, 'lead', 'lead', ${eventTypeId}, ${status},
                  ${revenue}::numeric, now(), NULL, NULL, ${stageSendId}::uuid)
          RETURNING id
        `)) as unknown as { id: number }[];
        return Number(rows[0].id);
      };
      // stage_send_id must reference a real row, so reuse whatever is there; if
      // the preview DB has no sends, the send-set checks are skipped explicitly.
      const send = (
        (await tx.execute(sql`
          SELECT id::text AS id FROM stage_sends WHERE org_id = ${orgId}::uuid LIMIT 1
        `)) as unknown as { id: string }[]
      )[0]?.id ?? null;

      await mk("approved", purchaseTypeId, "approved", "75.0000", send);
      await mk("pending", purchaseTypeId, "pending", "50.0000", null);
      await mk("rejected", purchaseTypeId, "rejected", "30.0000", null);
      await mk("reg", registrationTypeId, "approved", "0.0000", null);
      await mk("unmapped", null, null, "10.0000", null);

      const count = async (clause: SQL) =>
        Number(
          (
            (await tx.execute(sql`
              SELECT count(*)::int AS n FROM conversion_events ce
              WHERE ce.org_id = ${orgId}::uuid AND ce.keitaro_event_id LIKE ${`${tag}-%`} AND ${clause}
            `)) as unknown as { n: number }[]
          )[0].n,
        );
      const sum = async (clause: SQL) =>
        Number(
          (
            (await tx.execute(sql`
              SELECT coalesce(sum(ce.revenue), 0)::text AS s FROM conversion_events ce
              WHERE ce.org_id = ${orgId}::uuid AND ce.keitaro_event_id LIKE ${`${tag}-%`} AND ${clause}
            `)) as unknown as { s: string }[]
          )[0].s,
        );

      check("D1 purchasedClause counts the approved and the pending purchase", (await count(purchasedClause())) === 2);
      check("D2 purchasedClause excludes the rejected purchase", (await count(sql`${purchasedClause()} AND ce.status = 'rejected'`)) === 0);
      check("D3 purchasedClause excludes the registration", (await count(sql`${purchasedClause()} AND ce.event_type_id = ${registrationTypeId}`)) === 0);
      check("D4 registeredClause finds exactly the registration", (await count(registeredClause())) === 1);
      check(
        "D5 exactly 3 of the 5 seeded rows match a definition — the unmapped row and the rejected purchase match none",
        (await count(sql`(${purchasedClause()}) OR (${registeredClause()})`)) === 3,
      );
      check("D6 approved revenue sums approved only", (await sum(approvedRevenueClause())) === 75);
      check("D7 pending revenue sums pending only", (await sum(pendingRevenueClause())) === 50);
      check(
        "D8 ⭐ approved and pending revenue never overlap",
        (await count(sql`(${approvedRevenueClause()}) AND (${pendingRevenueClause()})`)) === 0,
      );
      if (send) {
        const ids = (await tx.execute(sql`${purchasedSendIds(orgId)}`)) as unknown as { stage_send_id: string }[];
        check("D9 purchasedSendIds returns the purchased send row", ids.some((r) => r.stage_send_id === send));
        const rescued = (await tx.execute(sql`${rescueSendIds(orgId)}`)) as unknown as {
          stage_send_id: string;
          first_event_at: string;
        }[];
        check("D10 rescueSendIds returns it with a first_event_at", rescued.some((r) => r.stage_send_id === send && r.first_event_at != null));
      } else {
        console.log("  SKIP  D9/D10 — the preview DB has no stage_sends row to attach a ledger row to");
      }
      check(
        "D11 the campaign-scoped purchase read can use conversion_events_campaign_event_idx",
        await usesIndex(
          tx,
          sql`SELECT ce.contact_id FROM conversion_events ce WHERE ce.campaign_id = 1 AND ce.contact_id IS NOT NULL AND ${purchasedClause()}`,
          "conversion_events_campaign_event_idx",
        ),
      );
      check(
        "D12 the contact-scoped purchase read can use conversion_events_contact_event_idx",
        await usesIndex(
          tx,
          sql`SELECT ce.id FROM conversion_events ce WHERE ce.contact_id = '00000000-0000-0000-0000-000000000000'::uuid AND ${purchasedClause()}`,
          "conversion_events_contact_event_idx",
        ),
      );
      check(
        "D13 the changed-rows read can use conversion_events_updated_at_idx (0182)",
        await usesIndex(
          tx,
          sql`SELECT DISTINCT ce.stage_id FROM conversion_events ce WHERE ce.updated_at >= now() - make_interval(mins => 30) AND ce.stage_id IS NOT NULL`,
          "conversion_events_updated_at_idx",
        ),
      );
      const col = (await tx.execute(sql`
        SELECT is_nullable, column_default, numeric_scale
        FROM information_schema.columns
        WHERE table_name = 'keitaro_stage_results' AND column_name = 'pending_revenue'
      `)) as unknown as { is_nullable: string; column_default: string; numeric_scale: number }[];
      check(
        "D14 keitaro_stage_results.pending_revenue is NOT NULL DEFAULT 0, numeric(12,4)",
        col.length === 1 && col[0].is_nullable === "NO" && Number(col[0].numeric_scale) === 4,
        JSON.stringify(col),
      );
      const archived = (await tx.execute(sql`
        UPDATE event_types SET status = 'archived' WHERE id = ${purchaseTypeId} RETURNING id
      `)) as unknown as { id: number }[];
      check("D15 ⭐ archiving the purchase type does NOT drop its history", archived.length === 1 && (await count(purchasedClause())) === 2);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  console.log(`\n${passed} passed, ${failed} failed  (transaction rolled back)`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
