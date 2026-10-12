// One-off operator action: cancel all FURTHER sends under campaign
// 143_61_082126_1 (id 905, "Lunavelle - 14443 - 08/21/26 - BS").
//
// Context: the Tells provider (855) auto-latched at 2026-08-21 14:36:02Z on
// "failure_spike: 10 consecutive send failures", freezing two released stages
// mid-drain. Resuming that provider would immediately fire their queued backlog.
// The operator wants everything already sent kept, and nothing further sent.
//
// The product's own recall (POST .../send/abort) REFUSES here: it only accepts
// un-released stages (sent_at NULL, no sent/sending rows), and both stages are
// released with sends on the board. Hence this script, which applies the same
// semantics adapted to a partially-sent stage.
//
// What it does, in ONE transaction:
//   1. pending  -> 'rejected'  (the abort route's bucket: operator-cancelled,
//      kept for audit, excluded from stage totals, and NOT resurrectable by the
//      human "retry failed" flow -- that flow only flips 'failed' -> 'pending').
//   2. sending  -> 'failed'    (at-most-once: a claimed row may have reached the
//      provider, so it is never re-sent; this is reconcileStuckStages' own
//      convention, applied here because send_approved=false below would make
//      that reconciler skip these stages forever).
//   3. send_approved -> false  on the affected stages (second drain barrier).
//   4. campaigns.send_paused -> true (the P7/P8 per-campaign latch, checked by
//      BOTH cron phases) so nothing else under this campaign can fire either.
//      Reversible from the UI via POST /api/campaigns/905/send-circuit
//      {action:"resume"} -- the only way to clear it.
//
// What it deliberately does NOT do:
//   - touch any 'sent' row (whatever went out stays out, as requested);
//   - clear materialized_at. The abort route nulls it so a stage can be
//     re-Prepared, but that is exactly wrong here: 'rejected' rows do not block
//     recipient re-enumeration (lib/sends/recipients.ts), so a re-materialize
//     would re-queue the very people we just cancelled. Keeping it set makes
//     kickoff short-circuit as "already fully materialized";
//   - touch stages 3013/3014 (already un-approved + un-materialized, so inert);
//   - touch the Tells provider latch. The operator resumes that themselves.
//
// Idempotent: a second run finds nothing pending/sending and reports no changes.
// Dry-run by default; pass --apply to write.
import "./_env-preload";

import postgres from "postgres";

const CAMPAIGN_ID = 905;
const EXPECTED_TRACKING_ID = "143_61_082126_1";
const APPLY = process.argv.includes("--apply");

const REJECT_NOTE =
  "operator_cancel: further sends cancelled for campaign 143_61_082126_1 (2026-08-21)";
const STRANDED_NOTE =
  "stranded in sending - drain interrupted by provider failure_spike latch; not retried (at-most-once)";
const PAUSE_REASON =
  "manual: further sends cancelled by operator after Tells failure_spike (2026-08-21)";

const conn = process.env.DATABASE_URL;
if (!conn) throw new Error("DATABASE_URL is not set (is .env.local present?)");
const sql = postgres(conn, { max: 2, prepare: false });

type Breakdown = { stage_id: number; tracking_id: string; status: string; n: number };

async function breakdown() {
  return (await sql`
    SELECT ss.stage_id, s.tracking_id, ss.status, count(*)::int AS n
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    WHERE s.campaign_id = ${CAMPAIGN_ID}
    GROUP BY ss.stage_id, s.tracking_id, ss.status
    ORDER BY ss.stage_id, ss.status
  `) as unknown as Breakdown[];
}

function show(label: string, rows: Breakdown[]) {
  console.log(`\n${label}`);
  if (rows.length === 0) console.log("  (no stage_sends rows)");
  for (const r of rows) {
    console.log(
      `  stage ${r.stage_id}  ${r.tracking_id.padEnd(26)} ${r.status.padEnd(18)} ${String(r.n).padStart(6)}`,
    );
  }
}

async function main() {
  // ---- Guard: prove we are pointed at the right campaign before writing. ----
  const camp = (await sql`
    SELECT id, org_id, tracking_id, name, status, send_paused, link_mode
    FROM campaigns WHERE id = ${CAMPAIGN_ID}
  `) as unknown as {
    id: number;
    org_id: string;
    tracking_id: string | null;
    name: string;
    status: string;
    send_paused: boolean;
    link_mode: string;
  }[];
  if (camp.length === 0) throw new Error(`campaign ${CAMPAIGN_ID} not found`);
  const c = camp[0];
  if (c.tracking_id !== EXPECTED_TRACKING_ID) {
    throw new Error(
      `REFUSING: campaign ${CAMPAIGN_ID} tracking_id is ${c.tracking_id}, expected ${EXPECTED_TRACKING_ID}`,
    );
  }
  console.log(`Campaign ${c.id} "${c.name}"`);
  console.log(
    `  tracking_id=${c.tracking_id} status=${c.status} send_paused=${c.send_paused} org=${c.org_id}`,
  );
  console.log(
    `\nMode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes; pass --apply to commit)"}`,
  );

  const before = await breakdown();
  show("BEFORE - stage_sends by stage/status:", before);

  const toCancel = before.filter((r) => r.status === "pending" || r.status === "sending");
  const pendingN = toCancel.filter((r) => r.status === "pending").reduce((s, r) => s + r.n, 0);
  const sendingN = toCancel.filter((r) => r.status === "sending").reduce((s, r) => s + r.n, 0);
  const stageIds = [...new Set(toCancel.map((r) => r.stage_id))].sort((a, b) => a - b);

  console.log(
    `\nWould cancel: ${pendingN} pending -> 'rejected', ${sendingN} sending -> 'failed', ` +
      `across stage(s) [${stageIds.join(", ")}]; campaign latch send_paused -> true.`,
  );

  if (!APPLY) {
    console.log("\nDry run - nothing written.");
    return;
  }
  if (stageIds.length === 0 && c.send_paused) {
    console.log("\nNothing to do (already cancelled and latched).");
    return;
  }

  await sql.begin(async (tx) => {
    // 1. Queued-but-never-attempted rows -> operator-cancelled bucket.
    const rejected = (await tx`
      UPDATE stage_sends SET status = 'rejected', last_error = ${REJECT_NOTE}
      WHERE org_id = ${c.org_id}
        AND status = 'pending'
        AND stage_id IN (SELECT id FROM campaign_stages WHERE campaign_id = ${CAMPAIGN_ID})
      RETURNING id
    `) as unknown as { id: string }[];

    // 2. Claimed-mid-flight rows -> terminal 'failed', never re-sent.
    const stranded = (await tx`
      UPDATE stage_sends SET status = 'failed', last_error = ${STRANDED_NOTE}
      WHERE org_id = ${c.org_id}
        AND status = 'sending'
        AND stage_id IN (SELECT id FROM campaign_stages WHERE campaign_id = ${CAMPAIGN_ID})
      RETURNING id
    `) as unknown as { id: string }[];

    // 3. Second drain barrier, scoped to only the stages we actually cancelled
    //    (so the untouched 15:00 pair keeps its own state).
    if (stageIds.length > 0) {
      await tx`
        UPDATE campaign_stages SET send_approved = false
        WHERE campaign_id = ${CAMPAIGN_ID} AND id IN ${tx(stageIds)}
      `;
    }

    // 4. Per-campaign latch: freezes every stage under this campaign in both
    //    cron phases, independent of the row-level cancellation above.
    await tx`
      UPDATE campaigns
      SET send_paused = true, send_paused_reason = ${PAUSE_REASON}, send_paused_at = now()
      WHERE id = ${CAMPAIGN_ID} AND send_paused IS NOT TRUE
    `;

    // 5. Audit trail, mirroring the abort route's event shape.
    for (const stageId of stageIds) {
      const rj = toCancel.find((r) => r.stage_id === stageId && r.status === "pending")?.n ?? 0;
      const st = toCancel.find((r) => r.stage_id === stageId && r.status === "sending")?.n ?? 0;
      const summary =
        `Further sends cancelled by operator: ${rj.toLocaleString()} queued message` +
        `${rj === 1 ? "" : "s"} discarded, ${st} stranded marked failed`;
      await tx`
        INSERT INTO campaign_events (org_id, campaign_id, stage_id, event_type, summary, metadata)
        VALUES (${c.org_id}, ${CAMPAIGN_ID}, ${stageId}, 'send_aborted', ${summary},
                ${sql.json({
                  discarded: rj,
                  stranded: st,
                  reason: "operator_cancel_after_failure_spike",
                  source: "scripts/cancel-campaign-905-sends.ts",
                })})
      `;
    }
    await tx`
      INSERT INTO campaign_events (org_id, campaign_id, event_type, summary, metadata)
      VALUES (${c.org_id}, ${CAMPAIGN_ID}, 'campaign_status_changed',
              'Campaign send latch engaged: no further sends until resumed',
              ${sql.json({
                send_paused: true,
                reason: PAUSE_REASON,
                source: "scripts/cancel-campaign-905-sends.ts",
              })})
    `;

    console.log(`\nCommitted: ${rejected.length} -> rejected, ${stranded.length} -> failed.`);
  });

  show("AFTER - stage_sends by stage/status:", await breakdown());
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("\nFAILED:", e);
    await sql.end();
    process.exit(1);
  });
