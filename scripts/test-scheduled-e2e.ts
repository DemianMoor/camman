// End-to-end: a fresh, in-window unmateriailzed stage flows through BOTH phases
// of one runScheduledSends tick — phase A materializes (batched kickoff), phase B
// drains it — and a SECOND tick resumes the leftover pending rows. Uses an
// isolated throwaway org with synthetic fixtures (no hardcoded live rows) in a
// ROLLED-BACK tx with an injected fake sender (no real SMS, nothing persisted).
//
// link_mode='manual' keeps kickoff simple: no tracking_id, short_domain, or link
// minting. Phase A needs only the campaign_audience_pool, a creative, and a valid
// scheduled_at. Phase B's real drain uses the injected fakeSender and stops at
// the per-minute soft ceiling (default 100), so tick 1 → 100 sent / 900 pending,
// tick 2 → 200 sent / 800 pending.
import "./_env-preload";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { runScheduledSends } from "@/lib/sends/scheduled";
import type { SendSmsResult } from "@/lib/sends/texthub";

class Rollback extends Error {}
let failed = 0;
function check(n: string, c: boolean, d = "") { if (!c) failed++; console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : `  ${d}`}`); }

// A weekday noon-ET slot (12:00 ET = 16:00Z, squarely inside the 08:00–21:00
// window) with the stage scheduled 5 minutes earlier so phase A fires it.
const NOW = new Date("2026-06-15T17:00:00Z");    // 1pm ET
const SCHEDULED = "2026-06-15T16:55:00Z";        // 5 min earlier, due

const CONTACT_COUNT = 1000;

async function main() {
  let sentCount = 0;
  const fakeSender = async (): Promise<SendSmsResult> => {
    sentCount++;
    return { ok: true, messageId: `fake-${sentCount}`, response: "ok", providerStatus: null, suppressed: false, rawBody: `{"id":"fake-${sentCount}"}`, error: null, status: 200, timedOut: false };
  };
  try {
    await db.transaction(async (tx) => {
      // ── Throwaway org — isolated from live state, rolled back at the end ──
      const orgRow = (await tx.execute(sql`
        INSERT INTO organizations (name) VALUES ('e2e-throwaway') RETURNING id
      `)) as unknown as { id: string }[];
      const orgId = orgRow[0].id;

      // Explicit org_settings so the real drain's getOrgSendsEnabled returns true.
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true
      `);

      // Creative: text carries opt-out language ("STOP") so the kickoff compliance
      // guard passes without needing special provider config.
      const cre = (await tx.execute(sql`
        INSERT INTO creatives (org_id, slug, text, status)
        VALUES (${orgId}, 'e2e-cre', ${"Test message. Reply STOP to opt out."}, 'active')
        RETURNING id
      `)) as unknown as { id: number }[];
      const creativeId = cre[0].id;

      // Campaign: manual link mode avoids tracking_id / short_domain / link-mint
      // requirements, so phase A succeeds with just the creative + audience pool.
      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, status, link_mode)
        VALUES (${orgId}, 'e2e-camp', 'active', 'manual')
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // Provider: full-day window so the suite is time-independent; max_sends_per_run
      // and max_sends_per_24h are NULL (defaults) — only max_sends_per_minute matters
      // (also NULL → default 100) for the per-tick ceiling assertion.
      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers
          (sms_provider_id, org_id, name, supports_api_send, status,
           send_window_weekday_start, send_window_weekday_end,
           send_window_weekend_start, send_window_weekend_end)
        VALUES ('e2e-prov', ${orgId}, ${"E2E"}, true, 'active', 0, 1439, 0, 1439)
        RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;

      // Credentials: the real drain resolves the api_key before calling fakeSender.
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${providerId}, NULL, ${"e2e-key"})
      `);

      // 1000 contacts + campaign_audience_pool in one CTE — single round trip.
      // was_no_status_at_snapshot=true matches the stage's default include_no_status=true
      // so all 1000 qualify as recipients in enumerateStageRecipients.
      await tx.execute(sql`
        WITH new_contacts AS (
          INSERT INTO contacts (org_id, phone_number)
          SELECT ${orgId}::uuid,
                 '+1555' || lpad(generate_series(1, ${CONTACT_COUNT})::text, 7, '0')
          RETURNING id
        )
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_no_status_at_snapshot)
        SELECT ${campaignId}::int, id, ${orgId}::uuid, true
        FROM new_contacts
      `);

      // Stage: materialized_at IS NULL so phase A fires kickoffStageSend and
      // materializes the 1000 stage_sends rows. Phase B then drains them.
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id,
           send_approved, scheduled_at)
        VALUES (${orgId}, ${campaignId}, 1, ${creativeId}, ${providerId},
                true, ${SCHEDULED})
        RETURNING id
      `)) as unknown as { id: number }[];
      const stageId = st[0].id;

      // ── TICK 1: phase A materializes 1000, phase B drains up to the per-minute
      //            soft ceiling (default 100), leaving 900 pending ──────────────
      const result = await runScheduledSends(tx as unknown as typeof db, {
        now: NOW,
        orgId,
        isEnabled: () => true,
        isOrgEnabled: async () => true,
        sendSms: fakeSender,
        maxStages: 50,
      });
      console.log("tick1:", JSON.stringify(result));
      check("tick1 materialized 1 (phase A fired the stage)", result.materialized === 1, `got ${result.materialized}`);
      check("tick1 drained 1 (phase B drained it same tick)", result.drained === 1, `got ${result.drained}`);
      check("tick1 sent 100 (per-minute soft ceiling)", result.sent === 100, `got ${result.sent}`);
      check("tick1 0 failed", result.failed === 0, `got ${result.failed}`);

      const st1 = (await tx.execute(sql`
        SELECT sent_at FROM campaign_stages WHERE id = ${stageId}
      `)) as unknown as { sent_at: string | null }[];
      check("stage sent_at stamped after phase B sends", st1[0].sent_at != null);

      const c1 = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
               count(*) FILTER (WHERE status='pending')::int AS pending
        FROM stage_sends WHERE stage_id = ${stageId}
      `)) as unknown as { sent: number; pending: number }[];
      check("after tick1: 100 sent / 900 pending",
        c1[0].sent === 100 && c1[0].pending === 900, JSON.stringify(c1[0]));

      // Backdate tick-1 sends past the 60s window so the soft ceiling resets,
      // then run TICK 2: phase A must SKIP the now-materialized stage, phase B
      // must RESUME it and drain the next 100. Proves resumability across ticks.
      await tx.execute(sql`
        UPDATE stage_sends SET sent_at = sent_at - interval '5 minutes'
        WHERE stage_id = ${stageId} AND status = 'sent'
      `);

      const tick2 = await runScheduledSends(tx as unknown as typeof db, {
        now: NOW,
        orgId,
        isEnabled: () => true,
        isOrgEnabled: async () => true,
        sendSms: fakeSender,
        maxStages: 50,
      });
      console.log("tick2:", JSON.stringify(tick2));
      check("tick2 materialized 0 (phase A skips materialized stage)", tick2.materialized === 0, `got ${tick2.materialized}`);
      check("tick2 drained 1 (phase B resumed it)", tick2.drained === 1, `got ${tick2.drained}`);
      check("tick2 sent another 100", tick2.sent === 100, `got ${tick2.sent}`);

      const c2 = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
               count(*) FILTER (WHERE status='pending')::int AS pending
        FROM stage_sends WHERE stage_id = ${stageId}
      `)) as unknown as { sent: number; pending: number }[];
      check("after tick2: 200 sent / 800 pending",
        c2[0].sent === 200 && c2[0].pending === 800, JSON.stringify(c2[0]));

      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nE2E two-phase + resumable scheduled send verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
