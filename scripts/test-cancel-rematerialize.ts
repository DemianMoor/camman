// Verifies "cancel a materialized stage before send" + clean re-materialize,
// against an ISOLATED manual-mode test fixture, with full cleanup. Manual mode
// (link_mode='manual', send_approved=false) is inert to the live cron — it is
// excluded from BOTH the Phase-A materialize selection and the Phase-B drain — so
// this never mints real links or risks a real send.
//
// Covers the safe-to-exercise brief matrix items:
//   1. materialize → N pending rows, materialized_at stamped
//   2. cancel (the exact abort-route SQL) → N rows flip to 'rejected', 0 pending,
//      materialized_at reset to NULL, send_approved false
//   3. panel status count (the new FILTER) → total EXCLUDES rejected ⇒ hasBatch
//      flips false ⇒ stage returns to the editable/Prepare state
//   4. re-enumeration → the canceled contacts are RE-INCLUDED (the load-bearing
//      recipients.ts `status <> 'rejected'` fix; pre-fix this returned 0)
//   5. re-materialize → N brand-new rows, no unique-constraint violation from the
//      canceled rows, materialized_at re-stamped; canceled rows kept for audit
//   6. guard → a stage with a 'sent' row is refused (the abort guard predicate)
//
// NOT exercised here (documented, not executed): the live cancel-vs-sender race
// and quiet-hours behavior. Race-safety is structural — cancel's
// `UPDATE ... WHERE status='pending'` and the drain's `FOR UPDATE SKIP LOCKED`
// claim serialize on the same rows so neither can double-take one — and firing a
// real drain would send real SMS (owner-gated). Quiet-hours code is untouched.
//
// Run: npx tsx scripts/test-cancel-rematerialize.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";
import {
  enumerateStageRecipients,
  type StageRecipientFilters,
} from "@/lib/sends/recipients";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

const TAG = "__wt-cancel-rematerialize-test__";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  const dbc = db as unknown as Parameters<typeof kickoffStageSend>[0];

  let campaignId: number | null = null;
  try {
    // ---- Fixture prerequisites: reuse an existing org/brand/creative/contacts ----
    const seed = (
      await db.execute(sql`
        SELECT c.org_id, c.brand_id, cr.id AS creative_id
        FROM campaigns c
        JOIN creatives cr ON cr.org_id = c.org_id AND cr.text IS NOT NULL
        WHERE c.brand_id IS NOT NULL
        LIMIT 1`)
    )[0] as { org_id: string; brand_id: number; creative_id: number };
    const orgId = seed.org_id;
    const contacts = (await db.execute(sql`
      SELECT id, phone_number FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
        AND id NOT IN (SELECT contact_id FROM opt_outs WHERE org_id = ${orgId})
      LIMIT 5`)) as unknown as { id: string; phone_number: string }[];
    if (contacts.length < 5) throw new Error("need >=5 usable contacts");
    const N = contacts.length;

    // ---- Insert a MANUAL, NOT-approved test campaign + due stage ----
    // send_approved=false + link_mode='manual' ⇒ invisible to both cron phases.
    campaignId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()},
                  ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    const stageId = Number(
      (
        await db.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
             scheduled_at, send_approved, include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${campaignId}, 1, ${seed.creative_id},
                  'https://example.com/x', 'Reply STOP to opt out',
                  now() - interval '1 minute', false, true, false, false)
          RETURNING id`)
      )[0].id,
    );
    for (const c of contacts) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${campaignId}, ${c.id}, true, false)`);
    }
    console.log(`fixture: campaign ${campaignId}, stage ${stageId}, pool ${N}\n`);

    const filters: StageRecipientFilters = {
      includeNoStatus: true, includeClickers: true, excludeClickers: false,
      splitIndex: null, splitTotal: null, behavioralTier: null, parentStageId: null,
    };
    const countBy = async () =>
      (
        (await db.execute(sql`
          SELECT
            count(*) FILTER (WHERE status = 'pending')::int  AS pending,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*)::int AS all_rows
          FROM stage_sends WHERE stage_id = ${stageId}`)) as unknown as {
          pending: number; rejected: number; all_rows: number;
        }[]
      )[0];
    // The panel's status-count query (with the new FILTER excluding rejected).
    const panelTotal = async () =>
      Number(
        (
          (await db.execute(sql`
            SELECT count(*) FILTER (WHERE status <> 'rejected')::int AS total
            FROM stage_sends WHERE stage_id = ${stageId} AND org_id = ${orgId}`)) as unknown as {
            total: number;
          }[]
        )[0].total,
      );
    const stageFlags = async () =>
      (
        (await db.execute(sql`
          SELECT materialized_at, send_approved
          FROM campaign_stages WHERE id = ${stageId}`)) as unknown as {
          materialized_at: string | null; send_approved: boolean;
        }[]
      )[0];

    // ---- 1. Fresh materialize ----
    // Baseline off the ACTUAL materialized count M (eligibility layers may
    // exclude some pool contacts — e.g. a contact already in-flight elsewhere).
    // The round-trip invariant is "re-materialize reproduces the SAME set", not
    // "pool size == materialized", so we self-calibrate to M rather than N.
    console.log("1) materialize:");
    const r1 = await kickoffStageSend(dbc, { orgId, campaignId, stageId });
    check("ok + complete", r1.ok && r1.complete === true, JSON.stringify(r1));
    const M = r1.ok ? r1.materialized : -1;
    check(`materialized M (${M}) of pool ${N}`, M >= 1 && M <= N);
    check("materialized_at stamped", (await stageFlags()).materialized_at != null);
    check(`${M} pending rows`, (await countBy()).pending === M);

    // ---- 2. Cancel (the exact abort-route SQL) ----
    console.log("2) cancel (recall):");
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE stage_sends SET status = 'rejected'
        WHERE stage_id = ${stageId} AND org_id = ${orgId} AND status = 'pending'`);
      await tx.execute(sql`
        UPDATE campaign_stages
        SET send_approved = false, schedule_missed_at = NULL, materialized_at = NULL
        WHERE id = ${stageId} AND org_id = ${orgId}`);
    });
    const afterCancel = await countBy();
    check(`${M} rows now 'rejected'`, afterCancel.rejected === M, `got ${afterCancel.rejected}`);
    check("0 pending", afterCancel.pending === 0);
    check("materialized_at reset to NULL", (await stageFlags()).materialized_at == null);
    check("send_approved false", (await stageFlags()).send_approved === false);

    // ---- 3. Panel status count excludes rejected ⇒ hasBatch flips false ----
    console.log("3) panel count → editable:");
    check("panel total = 0 (rejected excluded)", (await panelTotal()) === 0, `got ${await panelTotal()}`);

    // ---- 4. Re-enumeration re-includes the canceled contacts ----
    // Raw self-exclusion path (no eligibility overlay): post-cancel every pool
    // contact's only stage_sends row is 'rejected', so the `status <> 'rejected'`
    // fix makes ALL N re-enumerable. THIS is the load-bearing proof — pre-fix the
    // any-status NOT EXISTS would exclude all M canceled contacts (→ 0 remaining).
    // The eligibility-filtered round-trip is proven by the real kickoff in step 5.
    console.log("4) re-enumeration:");
    const remaining = await enumerateStageRecipients(dbc, {
      campaignId, orgId, filters, excludeMaterializedStageId: stageId,
    });
    check(
      `all ${N} pool contacts re-enumerable after cancel`,
      remaining.length === N,
      `got ${remaining.length} (pre-fix this would be 0)`,
    );

    // ---- 5. Clean re-materialize (no constraint violation from canceled rows) ----
    console.log("5) re-materialize:");
    const r2 = await kickoffStageSend(dbc, { orgId, campaignId, stageId });
    check("ok + complete", r2.ok && r2.complete === true, JSON.stringify(r2));
    check(`re-materialized ${M} new`, r2.ok && r2.materialized === M);
    check("materialized_at re-stamped", (await stageFlags()).materialized_at != null);
    const afterRemat = await countBy();
    check(`${M} pending again`, afterRemat.pending === M, `got ${afterRemat.pending}`);
    check(`${M} rejected rows kept for audit`, afterRemat.rejected === M, `got ${afterRemat.rejected}`);
    check(`${2 * M} total rows (new pending + audit rejected)`, afterRemat.all_rows === 2 * M, `got ${afterRemat.all_rows}`);
    check("panel total = M (still editable count correct)", (await panelTotal()) === M, `got ${await panelTotal()}`);

    // ---- 6. Guard: a stage with a 'sent' row is refused ----
    console.log("6) guard rejects when already sent:");
    // Flip one row to 'sent' and run the abort guard predicate exactly.
    const oneId = (
      (await db.execute(sql`
        SELECT id FROM stage_sends WHERE stage_id = ${stageId} AND status = 'pending' LIMIT 1`)) as unknown as {
        id: string;
      }[]
    )[0].id;
    await db.execute(sql`UPDATE stage_sends SET status = 'sent', sent_at = now() WHERE id = ${oneId}`);
    const guard = (
      (await db.execute(sql`
        SELECT s.sent_at AS sent_at,
               count(ss.*) FILTER (WHERE ss.status = 'sending')::int AS sending,
               count(ss.*) FILTER (WHERE ss.status = 'sent')::int AS sent
        FROM campaign_stages s
        LEFT JOIN stage_sends ss ON ss.stage_id = s.id
        WHERE s.id = ${stageId} AND s.org_id = ${orgId}
        GROUP BY s.sent_at`)) as unknown as {
        sent_at: string | null; sending: number; sent: number;
      }[]
    )[0];
    const blocked = guard.sent_at != null || Number(guard.sending) > 0 || Number(guard.sent) > 0;
    check("abort guard blocks (sent > 0)", blocked === true, JSON.stringify(guard));
  } finally {
    if (campaignId != null) {
      await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_audience_pool WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    }
    await pg.end({ timeout: 5 });
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
