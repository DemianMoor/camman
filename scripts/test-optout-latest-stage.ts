// Unit checks for the "one opt-out → latest stage" attribution rule
// (lib/sends/poll-opt-outs.ts, latestSendForAttribution). Seeds a throwaway
// campaign + stages + sends under a real org INSIDE a transaction that is ALWAYS
// rolled back — no row survives, no real data is touched.
//
//   npx tsx scripts/test-optout-latest-stage.ts
//
// Covers the four scenarios from the change brief:
//   1. lead messaged by 3 stages in the window → credited to the LATEST stage
//   2. tie-break on identical sent_at → higher stage_id wins
//   3. no in-window send → null (the `unattributed` case)
//   4. idempotent re-credit → ON CONFLICT keeps exactly one attribution row

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { latestSendForAttribution } from "@/lib/sends/poll-opt-outs";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const ANCHOR = "2026-06-23T18:00:00.000Z";
const rollback = new Error("__rollback__");

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const orgRows = (await db.execute(sql`
      SELECT id FROM organizations LIMIT 1
    `)) as unknown as { id: string }[];
    if (orgRows.length === 0) {
      console.log("⚠ no organizations in DB — cannot run; skipping.");
      await pg.end({ timeout: 5 });
      return;
    }
    const orgId = orgRows[0].id;

    try {
      await db.transaction(async (tx) => {
        // --- seed: one campaign, five stages, three phones ---
        const camp = (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name)
          VALUES (${orgId}, '__test_optout_latest', '__test_optout_latest')
          RETURNING id
        `)) as unknown as { id: number }[];
        const campaignId = camp[0].id;

        async function makeStage(n: number): Promise<number> {
          const r = (await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
            VALUES (${orgId}, ${campaignId}, ${n})
            RETURNING id
          `)) as unknown as { id: number }[];
          return r[0].id;
        }
        async function makeContact(phone: string): Promise<string> {
          const r = (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number)
            VALUES (${orgId}, ${phone})
            ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
            RETURNING id
          `)) as unknown as { id: string }[];
          return r[0].id;
        }
        async function makeSend(
          stageId: number,
          contactId: string,
          phone: string,
          sentAtIso: string,
        ): Promise<string> {
          const r = (await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone,
               rendered_text, status, sent_at)
            VALUES (${orgId}, ${campaignId}, ${stageId}, ${contactId}, ${phone},
                    'x', 'sent', ${sentAtIso}::timestamptz)
            RETURNING id
          `)) as unknown as { id: string }[];
          return r[0].id;
        }

        const sA = await makeStage(1);
        const sB = await makeStage(2);
        const sC = await makeStage(3);
        const sD = await makeStage(4);
        const sE = await makeStage(5);

        // Scenario 1: phone P1 messaged by 3 stages, latest = stage C.
        const P1 = "+15555550001";
        const c1 = await makeContact(P1);
        await makeSend(sA, c1, P1, "2026-06-23T16:00:00Z"); // anchor - 2h
        await makeSend(sB, c1, P1, "2026-06-23T17:00:00Z"); // anchor - 1h
        const sendC = await makeSend(sC, c1, P1, "2026-06-23T17:30:00Z"); // -30m (latest)

        const m1 = await latestSendForAttribution(tx, orgId, P1, ANCHOR);
        check("3 stages in window → exactly the latest stage", m1?.stage_id === sC, `got ${m1?.stage_id}, want ${sC}`);
        check("latest match points at the latest send row", m1?.stage_send_id === sendC);

        // Scenario 2: phone P2, two stages at the SAME sent_at → higher stage_id wins.
        const P2 = "+15555550002";
        const c2 = await makeContact(P2);
        const tie = "2026-06-23T17:50:00Z";
        await makeSend(sD, c2, P2, tie);
        await makeSend(sE, c2, P2, tie);
        const m2 = await latestSendForAttribution(tx, orgId, P2, ANCHOR);
        check("tie on sent_at → higher stage_id wins", m2?.stage_id === sE, `got ${m2?.stage_id}, want ${sE}`);

        // Scenario 3: phone P3, only an out-of-window send → unattributed (null).
        const P3 = "+15555550003";
        const c3 = await makeContact(P3);
        await makeSend(sA, c3, P3, "2026-06-19T10:00:00Z"); // anchor - ~104h (> 72h)
        const m3 = await latestSendForAttribution(tx, orgId, P3, ANCHOR);
        check("no in-window send → null (unattributed)", m3 === null);

        // Scenario 4: idempotent credit — inserting the same (opt_out, stage)
        // twice keeps exactly one row (the ON CONFLICT guard the poller relies on).
        const oo = (await tx.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${orgId}, ${c1}, ${P1}, 'sms_inbound')
          RETURNING id
        `)) as unknown as { id: number }[];
        const optOutId = oo[0].id;

        async function credit(): Promise<number> {
          const ins = (await tx.execute(sql`
            INSERT INTO opt_out_attributions
              (org_id, opt_out_id, stage_send_id, stage_id, campaign_id)
            VALUES (${orgId}, ${optOutId}, ${m1!.stage_send_id},
                    ${m1!.stage_id}, ${campaignId})
            ON CONFLICT (opt_out_id, stage_id) DO NOTHING
            RETURNING id
          `)) as unknown as { id: number }[];
          return ins.length;
        }
        check("first credit inserts 1 row", (await credit()) === 1);
        check("re-credit is a no-op (idempotent)", (await credit()) === 0);
        const cnt = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM opt_out_attributions WHERE opt_out_id = ${optOutId}
        `)) as unknown as { n: number }[];
        check("exactly one attribution row after re-credit", cnt[0].n === 1);

        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }

    // Prove nothing leaked.
    const leak = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaigns WHERE slug = '__test_optout_latest'
    `)) as unknown as { n: number }[];
    check("transaction rolled back (no residue)", leak[0].n === 0);
  } finally {
    await pg.end({ timeout: 5 });
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\nFAILED: ${failed} check(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
