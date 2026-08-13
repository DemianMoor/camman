import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/sends/textrequest-dlr";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { optOutBreakerAlertText } from "@/lib/sends/optout-rate-breaker";
import { reconcileTellsDlrEvent } from "@/lib/sends/tells-dlr";
import { processTellsOptOut } from "@/lib/sends/tells-optout";
import { readStageSendIdFromMetadata } from "@/lib/sends/tells-webhook-shared";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
} from "@/lib/reporting/cron-heartbeat";

// The sweeper — §4.1's guaranteed floor.
//
// The webhook handlers attempt processing inline, but that attempt is
// best-effort by design: the row is already committed before it runs, so a
// failure there is recoverable rather than lost. This drains everything the
// inline attempt missed, which is the whole reason Tells needs a retry loop
// that neither Ahoi nor Text Request has — Tells offers NO poll and NO
// reconciliation API, so if we drop an event there is no second source to
// recover it from.
//
// Ordered OLDEST FIRST: a STOP that has been sitting unprocessed longest is the
// most compliance-urgent. Bounded per run so one bad batch can't eat the
// invocation budget; whatever is left is picked up next tick.

const DEFAULT_BATCH = 200;

// Attempts past which we stop retrying automatically and alert instead. A row
// failing this many times is a code bug, not a transient — retrying it forever
// would silently mask it while burning the batch budget every tick.
const MAX_PROCESS_ATTEMPTS = 10;

export interface TellsSweepResult {
  scanned: number;
  dlrProcessed: number;
  inboundProcessed: number;
  suppressed: number;
  failed: number;
  stuck: number;
  monitorsStale: boolean;
}

// The other half of the mutual dead-man watch (§4.5). The monitors job watches
// this sweeper; this sweeper watches the monitors job — because a dead job
// cannot report itself dead, and between them they are the ONLY detection layer
// for broken STOP intake.
//
// Rate-limited to one alert per hour via its own cron_locks watermark: this
// runs every 5 minutes, so an unguarded alert would fire 12×/hour and get the
// channel muted — which would defeat the entire point.
const STALE_ALERT_KEY = "tells-monitors-stale-alert";
const STALE_ALERT_MIN_INTERVAL_HOURS = 1;

async function checkMonitorsAlive(dbc: DbOrTx): Promise<boolean> {
  const statuses = await checkHeartbeats(dbc, [HEARTBEAT_JOBS.tellsMonitors]);
  const breaches = heartbeatBreaches(statuses);
  if (breaches.length === 0) return false;

  const gate = (await dbc.execute(sql`
    SELECT watermark FROM cron_locks WHERE job_name = ${STALE_ALERT_KEY} LIMIT 1
  `)) as unknown as { watermark: string | null }[];
  const last = gate[0]?.watermark ? new Date(gate[0].watermark).getTime() : 0;
  const dueMs = STALE_ALERT_MIN_INTERVAL_HOURS * 3600 * 1000;
  if (Date.now() - last < dueMs) return true; // stale, but already alerted recently

  await dbc.execute(sql`
    INSERT INTO cron_locks (job_name, watermark) VALUES (${STALE_ALERT_KEY}, now())
    ON CONFLICT (job_name) DO UPDATE SET watermark = now()
  `);
  void notifyTelegram(
    `🚨 <b>Tells monitors are not running.</b>\n` +
      breaches.map((b) => `• ${b}`).join("\n") +
      `\n\nThey are the SOLE detection layer for broken STOP intake — while they are ` +
      `down, a broken inbound webhook would produce no symptom at all.`,
  ).catch(() => {});
  return true;
}

export async function sweepTellsWebhookEvents(
  dbc: DbOrTx,
  opts?: { orgId?: string; limit?: number },
): Promise<TellsSweepResult> {
  const limit = opts?.limit ?? DEFAULT_BATCH;
  const rows = (await dbc.execute(sql`
    SELECT id, org_id, kind, from_number, body, provider_message_id, metadata_raw,
           received_at, process_attempts
    FROM tells_webhook_events
    WHERE processed_at IS NULL
      AND process_attempts < ${MAX_PROCESS_ATTEMPTS}
      ${opts?.orgId ? sql`AND org_id = ${opts.orgId}` : sql``}
    ORDER BY received_at ASC
    LIMIT ${limit}
  `)) as unknown as {
    id: string;
    org_id: string;
    kind: "dlr" | "inbound";
    from_number: string | null;
    body: string | null;
    provider_message_id: string | null;
    metadata_raw: string | null;
    received_at: string;
    process_attempts: number;
  }[];

  const out: TellsSweepResult = {
    scanned: rows.length, dlrProcessed: 0, inboundProcessed: 0,
    suppressed: 0, failed: 0, stuck: 0, monitorsStale: false,
  };

  for (const r of rows) {
    try {
      if (r.kind === "dlr") {
        await reconcileTellsDlrEvent(dbc, {
          eventId: r.id,
          orgId: r.org_id,
          stageSendId: readStageSendIdFromMetadata(r.metadata_raw),
          providerMessageId: r.provider_message_id,
        });
        out.dlrProcessed++;
      } else {
        const outcome = await processTellsOptOut(dbc, {
          eventId: r.id,
          orgId: r.org_id,
          fromNumber: r.from_number,
          body: r.body,
          // The ORIGINAL receipt time, not now() — the opt-out's created_at and
          // its attribution window must reflect when the STOP actually arrived,
          // not when we got around to processing it. A sweep hours later must
          // not re-date a suppression.
          receivedAt: new Date(r.received_at),
        });
        out.inboundProcessed++;
        if (outcome.kind === "suppressed") {
          out.suppressed++;
          if (outcome.breakerTrip) {
            void notifyTelegram(
              optOutBreakerAlertText(outcome.breakerTrip.campaignId, null, outcome.breakerTrip.result),
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      out.failed++;
      // Record the failure and bump the attempt counter so a poison row cannot
      // spin forever. processed_at stays NULL so it is retried next tick, up to
      // MAX_PROCESS_ATTEMPTS.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await dbc.execute(sql`
          UPDATE tells_webhook_events
          SET process_attempts = process_attempts + 1, process_error = ${msg.slice(0, 500)}
          WHERE id = ${r.id}
        `);
      } catch {
        // If even the bookkeeping write fails the row simply retries next tick.
      }
      console.error(`[tells-sweep] processing failed for event=${r.id} kind=${r.kind}`, err);
    }
  }

  // Rows that exhausted their retries. Surfaced here rather than silently
  // filtered out of the query above — a row stuck at the cap is exactly the
  // thing that must not go unnoticed on a compliance path.
  const stuckRows = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM tells_webhook_events
    WHERE processed_at IS NULL AND process_attempts >= ${MAX_PROCESS_ATTEMPTS}
      ${opts?.orgId ? sql`AND org_id = ${opts.orgId}` : sql``}
  `)) as unknown as { n: number }[];
  out.stuck = stuckRows[0]?.n ?? 0;
  if (out.stuck > 0) {
    void notifyTelegram(
      `🚨 Tells sweeper: ${out.stuck} webhook event(s) stuck at ≥${MAX_PROCESS_ATTEMPTS} failed ` +
        `processing attempts and are no longer being retried. If any are inbound, STOPs are ` +
        `UNSUPPRESSED. Inspect tells_webhook_events WHERE processed_at IS NULL.`,
    ).catch(() => {});
  }

  // Mutual dead-man watch — see checkMonitorsAlive. Never allowed to fail the
  // sweep: draining STOPs matters more than reporting on a sibling job.
  try {
    out.monitorsStale = await checkMonitorsAlive(dbc);
  } catch (err) {
    console.error("[tells-sweep] monitors heartbeat check failed", err);
  }

  return out;
}
