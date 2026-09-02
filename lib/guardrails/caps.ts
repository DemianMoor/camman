import "server-only";

import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, stage_sends } from "@/db/schema";

// Volume caps (ClickUp 869et3vm1, Phase 3).
//
// ⚠️ NOTHING HERE RUNS ON THE FIRE PATH. Both caps are evaluated when a human
// asks for something — Prepare/kickoff, or schedule/activate — and never inside
// materialize or the drain. The drain's predicate is untouched by this phase.
//
// That placement is the whole design. A cap enforced at fire time would have to
// decide, mid-batch, whether to stop half-way through a send; a cap enforced at
// request time refuses an ASSIGNMENT that has not happened yet, which is
// reversible, explainable, and costs the send path nothing.

/** Per-stage ceiling: recipients this stage may materialize in one hour. */
export const PER_STAGE_HOURLY_CAP = 10_000;

/**
 * Org-wide ceiling across every stage in the last hour.
 *
 * 60,000 — Dmytro, 2026-09-01, final. The card originally said 10,000, which was
 * measured to be ~4x below live throughput (41,347 sends in a single hour,
 * 58K-104K/day), i.e. it would have stopped the operation on day one.
 */
export const AGGREGATE_HOURLY_CAP = 60_000;

export type CapRefusal = {
  cap: "per_stage_hourly" | "aggregate_hourly";
  limit: number;
  current: number;
  requested: number;
  wouldTotal: number;
  message: string;
};

/**
 * Sends across the whole org in the trailing hour.
 *
 * Measured at 418ms against production (recon §7), stable across runs, using
 * `stage_sends_org_sent_at_idx`. Cheap enough to run synchronously in a request
 * that a human is waiting on — which is exactly why the cap lives here and not
 * somewhere it would have to be precomputed.
 */
export async function sentInLastHour(orgId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stage_sends)
    .where(
      and(
        eq(stage_sends.org_id, orgId),
        eq(stage_sends.status, "sent"),
        gte(stage_sends.sent_at, sql`now() - interval '1 hour'`),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Recipients this stage has already materialized in the trailing hour. */
export async function stageMaterializedInLastHour(
  orgId: string,
  stageId: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stage_sends)
    .where(
      and(
        eq(stage_sends.org_id, orgId),
        eq(stage_sends.stage_id, stageId),
        gte(stage_sends.created_at, sql`now() - interval '1 hour'`),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Per-stage cap, checked at Prepare/kickoff.
 *
 * Counts rows MATERIALIZED in the last hour rather than sent: kickoff is the
 * act being gated, and a stage that materialized 10,000 rows a minute ago has
 * already spent the hour's budget whether or not the drain has caught up.
 */
export async function checkPerStageCap(opts: {
  orgId: string;
  stageId: number;
  requested: number;
}): Promise<CapRefusal | null> {
  const current = await stageMaterializedInLastHour(opts.orgId, opts.stageId);
  const wouldTotal = current + opts.requested;
  if (wouldTotal <= PER_STAGE_HOURLY_CAP) return null;
  return {
    cap: "per_stage_hourly",
    limit: PER_STAGE_HOURLY_CAP,
    current,
    requested: opts.requested,
    wouldTotal,
    message:
      `This stage would reach ${wouldTotal.toLocaleString()} recipients in one hour, ` +
      `over the ${PER_STAGE_HOURLY_CAP.toLocaleString()}/hour limit ` +
      `(${current.toLocaleString()} already prepared in the last hour). ` +
      `Split it across hours or reduce the audience.`,
  };
}

/**
 * Aggregate org-wide cap, checked at schedule/activate.
 *
 * ⚠️ `requested` is the WHOLE audience of the thing being scheduled, not a
 * delta. Ten stages of 9,999 must not pass — which they would if each were
 * measured only against what had already SENT, since none of them has sent
 * anything at the moment they are scheduled. So the caller must also count
 * what is already scheduled-but-unsent; see `pendingScheduledRecipients`.
 */
export async function checkAggregateCap(opts: {
  orgId: string;
  requested: number;
  /** Already-scheduled-but-unsent recipients to count against the same hour. */
  pending?: number;
}): Promise<CapRefusal | null> {
  const sent = await sentInLastHour(opts.orgId);
  return decideAggregateCap({
    sent,
    pending: opts.pending ?? 0,
    requested: opts.requested,
  });
}

/**
 * The cap DECISION, split out from the query so it can be tested at an exact
 * boundary without seeding tens of thousands of rows.
 *
 * This is where the bug would live — off-by-one at the limit, forgetting to add
 * `pending`, comparing before adding `requested`. The SQL half is exercised
 * separately against a real database.
 */
export function decideAggregateCap(input: {
  sent: number;
  pending: number;
  requested: number;
}): CapRefusal | null {
  const { sent, pending, requested } = input;
  const current = sent + pending;
  const wouldTotal = current + requested;
  if (wouldTotal <= AGGREGATE_HOURLY_CAP) return null;
  return {
    cap: "aggregate_hourly",
    limit: AGGREGATE_HOURLY_CAP,
    current,
    requested,
    wouldTotal,
    message:
      `This would take the org to ${wouldTotal.toLocaleString()} recipients in one hour, ` +
      `over the ${AGGREGATE_HOURLY_CAP.toLocaleString()}/hour limit ` +
      `(${sent.toLocaleString()} already sent, ${pending.toLocaleString()} scheduled and unsent). ` +
      `Move this to a later hour.`,
  };
}

/**
 * Recipients already materialized for stages that are approved and have not
 * sent — the "ten stages of 9,999" case.
 *
 * Without this the aggregate cap is trivially defeated: each stage is scheduled
 * while the others have sent nothing, so each sees a near-zero count and passes.
 */
export async function pendingScheduledRecipients(orgId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stage_sends)
    .innerJoin(campaign_stages, eq(campaign_stages.id, stage_sends.stage_id))
    .where(
      and(
        eq(stage_sends.org_id, orgId),
        eq(stage_sends.status, "pending"),
        eq(campaign_stages.send_approved, true),
        isNull(campaign_stages.sent_at),
      ),
    );
  return rows[0]?.n ?? 0;
}
