// End-to-end: a fresh, in-window tracked stage flows through BOTH phases of one
// runScheduledSends tick — phase A materializes (batched kickoff), phase B
// drains it — and a SECOND tick resumes the leftover pending rows. Uses the
// REAL stage 146's config but in a ROLLED-BACK tx with an injected fake sender
// (no TextHub, nothing persisted).
import "./_env-preload";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { runScheduledSends } from "@/lib/sends/scheduled";
import type { SendSmsResult } from "@/lib/sends/texthub";

class Rollback extends Error {}
let failed = 0;
function check(n: string, c: boolean, d = "") { if (!c) failed++; console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : `  ${d}`}`); }

// Same ET day for scheduled_at and now, inside the 08:00–21:00 window → "fire".
const NOW = new Date("2026-06-12T17:00:00Z");          // 1pm ET
const SCHEDULED = "2026-06-12T16:55:00Z";              // 5 min earlier

async function main() {
  let sentCount = 0;
  const fakeSender = async (): Promise<SendSmsResult> => {
    sentCount++;
    return { ok: true, messageId: `fake-${sentCount}`, response: "ok", error: null, status: 200 };
  };
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT org_id FROM campaigns WHERE id = 110`)) as unknown as { org_id: string }[];
      const orgId = org[0].org_id;

      // Arm stage 146: clear the stuck claim, bump schedule into the window.
      await tx.execute(sql`
        UPDATE campaign_stages SET sent_at = NULL, schedule_missed_at = NULL, scheduled_at = ${SCHEDULED}
        WHERE id = 146
      `);

      // Tick 1: phase A materializes 1000, phase B drains until the per-minute
      // soft ceiling (default 100) stops it — the rest stay pending.
      const result = await runScheduledSends(tx as unknown as typeof db, {
        now: NOW, orgId, isEnabled: () => true, sendSms: fakeSender, maxStages: 50,
      });
      console.log("tick1:", JSON.stringify(result));
      check("tick1 materialized 1 (phase A fired stage 146)", result.materialized === 1, `got ${result.materialized}`);
      check("tick1 drained 1 (phase B drained it same tick)", result.drained === 1, `got ${result.drained}`);
      check("tick1 sent 100 (per-minute soft ceiling)", result.sent === 100, `got ${result.sent}`);
      check("tick1 0 failed", result.failed === 0, `got ${result.failed}`);

      const st = (await tx.execute(sql`SELECT sent_at FROM campaign_stages WHERE id = 146`)) as unknown as { sent_at: string | null }[];
      check("stage 146 sent_at stamped (after materialize)", st[0].sent_at != null);

      const c1 = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
               count(*) FILTER (WHERE status='pending')::int AS pending
        FROM stage_sends WHERE stage_id = 146
      `)) as unknown as { sent: number; pending: number }[];
      check("after tick1: 100 sent / 900 pending", c1[0].sent === 100 && c1[0].pending === 900, JSON.stringify(c1[0]));

      // Backdate tick-1 sends past the 60s window so the soft ceiling resets,
      // then run TICK 2: phase A must SKIP the now-materialized stage, phase B
      // must RESUME it and drain the next 100. Proves resumability across ticks.
      await tx.execute(sql`
        UPDATE stage_sends SET sent_at = sent_at - interval '5 minutes'
        WHERE stage_id = 146 AND status = 'sent'
      `);
      const tick2 = await runScheduledSends(tx as unknown as typeof db, {
        now: NOW, orgId, isEnabled: () => true, sendSms: fakeSender, maxStages: 50,
      });
      console.log("tick2:", JSON.stringify(tick2));
      check("tick2 materialized 0 (phase A skips materialized stage)", tick2.materialized === 0, `got ${tick2.materialized}`);
      check("tick2 drained 1 (phase B resumed it)", tick2.drained === 1, `got ${tick2.drained}`);
      check("tick2 sent another 100", tick2.sent === 100, `got ${tick2.sent}`);

      const c2 = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
               count(*) FILTER (WHERE status='pending')::int AS pending
        FROM stage_sends WHERE stage_id = 146
      `)) as unknown as { sent: number; pending: number }[];
      check("after tick2: 200 sent / 800 pending", c2[0].sent === 200 && c2[0].pending === 800, JSON.stringify(c2[0]));

      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nE2E two-phase + resumable scheduled send verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
