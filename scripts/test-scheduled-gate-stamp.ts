// Bug 1 regression: the scheduler must stamp campaign_stages.sent_at ONLY after a
// drain pass actually attempts a send (processed > 0). A gate-refused tick (DB
// sends_enabled off) must leave sent_at NULL and the stage re-selectable.
//
// Uses the REAL drain (so the org-flag gate genuinely refuses) with an injected
// fake sendSms for the gate-OPEN pass. Single rolled-back tx; nothing persists.
// Run: npx tsx scripts/test-scheduled-gate-stamp.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { runScheduledSends } from "@/lib/sends/scheduled";
import type { SendSmsResult } from "@/lib/sends/texthub";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const NOON_ET = new Date("2026-06-15T16:00:00Z"); // weekday 12:00 ET → in window
const SCHEDULED = "2026-06-15T15:55:00Z"; // 5 min earlier, due
const ROLLBACK = Symbol("rollback");

async function main() {
  let sendCalls = 0;
  const fakeSender = async (): Promise<SendSmsResult> => {
    sendCalls++;
    return { ok: true, messageId: `m-${sendCalls}`, response: "ok", providerStatus: null, suppressed: false, rawBody: `{"id":"m-${sendCalls}"}`, error: null, status: 200, timedOut: false };
  };

  try {
    await db.transaction(async (tx) => {
      // Throwaway org — never committed, so no teardown needed.
      const orgRow = (await tx.execute(sql`
        INSERT INTO organizations (name) VALUES ('gate-stamp-throwaway') RETURNING id
      `)) as unknown as { id: string }[];
      const orgId = orgRow[0].id;

      // The gate-stamp test itself inserts and toggles org_settings.sends_enabled,
      // so we don't pre-seed it here. The first INSERT below (gate off) creates the
      // row for the throwaway org.

      // Full-day window so the suite is time-independent; NOON_ET is always inside
      // regardless of the real clock.
      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers
          (sms_provider_id, org_id, name, supports_api_send,
           send_window_weekday_start, send_window_weekday_end,
           send_window_weekend_start, send_window_weekend_end)
        VALUES ('gs-prov', ${orgId}, ${"gate-stamp"}, true, 0, 1439, 0, 1439)
        RETURNING id
      `)) as unknown as { id: number }[];
      const provId = prov[0].id;

      // Credential with brand_id=NULL: the real drain resolves it as the
      // provider-default credential, matching the campaign's brand_id=NULL below.
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${provId}, NULL, ${"key"})
      `);

      const cre = (await tx.execute(sql`
        INSERT INTO creatives (slug, org_id, text, status)
        VALUES ('gs-cre', ${orgId}, ${"hi"}, 'active') RETURNING id
      `)) as unknown as { id: number }[];

      // No brand_id on the campaign: the provider_credentials row above uses
      // brand_id=NULL, which the real drain resolves as the provider-default key.
      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, 'gs-camp', ${"g"}, 'active', 'tracked') RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // Stage pre-materialized (materialized_at set) so phase B finds it
      // immediately; phase A skips it (materialized_at IS NULL filter fails).
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id,
           send_approved, scheduled_at, materialized_at)
        VALUES (${orgId}, ${campaignId}, 1, ${cre[0].id}, ${provId},
                true, ${SCHEDULED}, now())
        RETURNING id
      `)) as unknown as { id: number }[];
      const stageId = st[0].id;

      const contact = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+15551000001"}) RETURNING id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${campaignId}, ${stageId}, ${contact[0].id}, ${"+15550000"}, ${"hi link"}, 'pending')
      `);

      const sentAt = async () =>
        ((await tx.execute(sql`SELECT sent_at FROM campaign_stages WHERE id = ${stageId}`)) as unknown as { sent_at: string | null }[])[0].sent_at;
      const pendingCount = async () =>
        Number(((await tx.execute(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stageId} AND status = 'pending'`)) as unknown as { n: number }[])[0].n);

      // ── TICK 1: gate OFF (sends_enabled false). Real drain refuses. ──
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, false)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = false
      `);
      const t1 = await runScheduledSends(tx as unknown as typeof db, {
        now: NOON_ET, orgId, isEnabled: () => true, sendSms: fakeSender, maxStages: 50,
      });
      check("gate off: 0 sent", t1.sent === 0, JSON.stringify(t1));
      check("gate off: sendSms never called", sendCalls === 0, `calls ${sendCalls}`);
      check("gate off: sent_at stays NULL (no false 'Sent')", (await sentAt()) === null);
      check("gate off: rows stay pending", (await pendingCount()) === 1);

      // ── Open the gate, then TICK 2: real drain sends, sent_at stamped. ──
      await tx.execute(sql`UPDATE org_settings SET sends_enabled = true WHERE org_id = ${orgId}`);
      const t2 = await runScheduledSends(tx as unknown as typeof db, {
        now: NOON_ET, orgId, isEnabled: () => true, sendSms: fakeSender, maxStages: 50,
      });
      check("gate on: 1 sent", t2.sent === 1, JSON.stringify(t2));
      check("gate on: sendSms called once", sendCalls === 1, `calls ${sendCalls}`);
      check("gate on: sent_at stamped only after a real send", (await sentAt()) !== null);
      check("gate on: row drained", (await pendingCount()) === 0);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nBug 1 — sent_at integrity verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
