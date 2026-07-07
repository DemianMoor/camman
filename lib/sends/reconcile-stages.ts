import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// A stranded stage is one that sent (or tried to) but never reached a finalized
// state: `campaign_stages.sent_at` NULL despite ≥1 accepted send, and/or rows
// stuck in 'sending' because a drain invocation was interrupted (Vercel 300s
// cap / crash) before it could resolve them. Such a stage has NO 'pending' rows,
// so the drain selector (selectDrainableStages) never re-picks it — it can never
// self-heal from the drain path. This pass finalizes it.
//
// SAFETY — at-most-once. A row stuck in 'sending' may already have been accepted
// by TextHub (the process died AFTER the send, before recording it), so it is
// NEVER re-sent (that would double-text). We mark it 'failed' (terminal); the
// operator can deliberately retry via the retry-failed flow.
//
// To be certain no LIVE drain is holding a row, a stage is eligible only when it
// has had NO send activity for `staleMinutes`, measured TWO ways: (a) no
// `send_attempts` row (the drain writes one per attempt) within the window, and
// (b) its newest 'sent'/'sending' row activity is older than the window. (a) is
// the load-bearing guard — a 'sending' row's own `created_at` is its
// MATERIALIZATION time (unrelated to when a drain claimed it), so a stage
// materialized long ago and drained *now* by the concurrent manual /send/drain
// route would look stale by (b) alone; the send_attempts clock tracks actual
// drain liveness. The only residual (sub-second) window is a drain that has
// claimed a batch but not yet recorded its first attempt — and even then the
// drain's id-keyed 'sent' UPDATE is idempotent, so no message is re-sent.

const DEFAULT_STALE_MINUTES = 15;
const DEFAULT_MAX_STAGES = 200;
const STRANDED_ERROR =
  "stranded in sending — drain interrupted; not retried (at-most-once)";

export interface ReconcileResult {
  scanned: number; // stranded stages selected
  reclaimed: number; // stale 'sending' rows marked 'failed'
  stampedSentAt: number; // stages whose sent_at was stamped
  recomputed: number; // stages whose total_cost was recomputed
}

export async function reconcileStuckStages(
  dbc: DbOrTx,
  opts?: {
    now?: Date;
    orgId?: string; // scope to one org (manual trigger); omit for the cron (all orgs)
    staleMinutes?: number;
    maxStages?: number;
  },
): Promise<ReconcileResult> {
  const staleMinutes = opts?.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const maxStages = opts?.maxStages ?? DEFAULT_MAX_STAGES;
  const orgId = opts?.orgId;
  const nowIso = (opts?.now ?? new Date()).toISOString();

  // Select stranded stages: tracked+active+approved+materialized, NO pending
  // rows (not drainable), needing finalization (stuck 'sending' OR sent-with-no-
  // fire-lock), whose most recent activity is older than the stale threshold.
  const candidates = (await dbc.execute(sql`
    SELECT s.id AS stage_id
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      AND s.send_approved = true
      AND s.archived_at IS NULL
      AND s.materialized_at IS NOT NULL
      ${orgId ? sql`AND c.org_id = ${orgId}::uuid` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'pending'
      )
      AND (
        EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.stage_id = s.id AND ss.status = 'sending'
        )
        OR (
          s.sent_at IS NULL
          AND EXISTS (
            SELECT 1 FROM stage_sends ss
            WHERE ss.stage_id = s.id AND ss.status = 'sent'
          )
        )
      )
      -- (a) no drain has ATTEMPTED a send on this stage within the window (the
      -- real drain-liveness clock — every attempt writes a send_attempts row).
      AND NOT EXISTS (
        SELECT 1 FROM send_attempts sa
        JOIN stage_sends ss2 ON ss2.id = sa.stage_send_id
        WHERE ss2.stage_id = s.id
          AND sa.created_at >= ${nowIso}::timestamptz - make_interval(mins => ${staleMinutes})
      )
      -- (b) newest 'sent'/'sending' row activity is also stale (defense-in-depth).
      AND (
        SELECT max(GREATEST(ss.sent_at, ss.created_at))
        FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status IN ('sent', 'sending')
      ) < ${nowIso}::timestamptz - make_interval(mins => ${staleMinutes})
    ORDER BY s.id
    LIMIT ${maxStages}
  `)) as unknown as { stage_id: number }[];

  let reclaimed = 0;
  let stampedSentAt = 0;
  let recomputed = 0;

  for (const { stage_id } of candidates) {
    // 1. Stale 'sending' → 'failed' (terminal; NOT re-sent — at-most-once).
    const failedRows = (await dbc.execute(sql`
      UPDATE stage_sends
      SET status = 'failed', last_error = ${STRANDED_ERROR}
      WHERE stage_id = ${stage_id} AND status = 'sending'
      RETURNING id
    `)) as unknown as { id: string }[];
    reclaimed += failedRows.length;

    // 2. Stamp the stage fire-lock when ≥1 message actually sent (COALESCE keeps
    //    an existing value; guarded so a no-send stage never false-reads "Sent").
    const stamped = (await dbc.execute(sql`
      UPDATE campaign_stages
      SET sent_at = COALESCE(sent_at, ${nowIso}::timestamptz)
      WHERE id = ${stage_id}
        AND sent_at IS NULL
        AND EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.stage_id = ${stage_id} AND ss.status = 'sent'
        )
      RETURNING id
    `)) as unknown as { id: number }[];
    if (stamped.length > 0) stampedSentAt++;

    // 3. Recompute cost from the now-final 'sent' count (Fix A unblocks this even
    //    when sent_at was just stamped / stays NULL for a zero-send stage).
    await recomputeStageTotalCost(dbc, stage_id);
    recomputed++;
  }

  return { scanned: candidates.length, reclaimed, stampedSentAt, recomputed };
}
