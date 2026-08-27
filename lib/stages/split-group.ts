import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { campaignTierExpr } from "@/lib/campaign-tier";
import { resolveCompletedStages } from "@/lib/sends/stage-complete";

// ── Behavioural split GROUP state machine (migration 0174) ───────────────────
//
//   pending ──recompute──▶ materializing ──all lanes done──▶ materialized
//                                │
//                                └──any lane permanently refused──▶ failed
//
// ATOMICITY IS AT THE **RELEASE** BOUNDARY, NOT THE INSERT BOUNDARY.
// Materialization stays exactly as it is today: per-lane, windowed, per-window
// commit, resumable (lib/sends/kickoff.ts commits every 2,000 rows and forbids an
// outer transaction). Making the trio one transaction was measured at ~30–65s for
// the largest real trio (18,755 combined rows at ~500–900 rows/s) — it would hold
// one transaction-pooler connection for that long, breach the 300s route ceiling
// at ~3× today's size, and throw away the resumability that exists precisely
// because a 60s timeout used to roll back ~17K recipients.
//
// So instead: lanes materialize independently, and **Phase B refuses to release
// any lane until its GROUP is 'materialized'**. If one lane fails, the group goes
// 'failed' and NO lane releases. Rows already written by the lanes that did
// succeed are deliberately left in place, unreleased — rolling them back would be
// a second failure mode with nothing to gain, and the existing abort path
// (`.../send/abort`) is how an operator clears them.
//
// A lane that resolves to ZERO recipients is 'skipped_empty', which SATISFIES the
// group — under campaign-level classification an empty tier is routine, not an error.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SplitGroupState =
  | "pending"
  | "materializing"
  | "materialized"
  | "failed";

export interface SplitGroupRow {
  id: string;
  org_id: string;
  campaign_id: number;
  anchor_stage_id: number | null;
  source_stage_ids: number[];
  state: SplitGroupState;
  recomputed_at: string | null;
  last_error: string | null;
}

export async function getSplitGroup(
  dbc: DbOrTx,
  groupId: string,
): Promise<SplitGroupRow | null> {
  const rows = (await dbc.execute(sql`
    SELECT id, org_id, campaign_id, anchor_stage_id, source_stage_ids,
           state, recomputed_at, last_error
    FROM campaign_stage_split_groups
    WHERE id = ${groupId}::uuid
    LIMIT 1
  `)) as unknown as SplitGroupRow[];
  return rows[0] ?? null;
}

// ── Recompute: resolve the source set and arm the group ─────────────────────
//
// Derives the campaign's COMPLETED stages LIVE (shared predicate — see
// lib/sends/stage-complete.ts), persists them onto the group, stamps
// `recomputed_at`, and moves `pending → materializing`.
//
// Deriving live at THIS moment (rather than freezing the set when the split was
// created) is the whole point: a stage that finishes sending between the split
// being created and this recompute MUST be in the source set.
//
// IDEMPOTENT and racy-safe: the UPDATE is guarded on `state = 'pending'`, so two
// concurrent callers (the T−15 preflight cron and a Phase A tick) can both call it
// and exactly one wins. The loser reads back the winner's row.
//
// Returns the group as it stands after the call, or null if the group is gone.
export async function ensureGroupSourceResolved(
  dbc: DbOrTx,
  groupId: string,
): Promise<SplitGroupRow | null> {
  const existing = await getSplitGroup(dbc, groupId);
  if (!existing) return null;
  if (existing.state !== "pending") return existing;

  const completed = await resolveCompletedStages(
    dbc,
    Number(existing.campaign_id),
    existing.org_id,
  );
  const ids = completed.map((s) => Number(s.id));

  if (ids.length === 0) {
    // No completed source stages — the split can't classify anyone. Fail loudly
    // rather than materializing three empty lanes: an operator created this split
    // against a campaign whose stages were since archived or un-sent.
    await failSplitGroup(dbc, groupId, "no_completed_source_stages");
    return await getSplitGroup(dbc, groupId);
  }

  await dbc.execute(sql`
    UPDATE campaign_stage_split_groups
    SET source_stage_ids = ${sql`ARRAY[${sql.join(
      ids.map((i) => sql`${i}::int`),
      sql`, `,
    )}]::int[]`},
        recomputed_at = now(),
        state = 'materializing'
    WHERE id = ${groupId}::uuid AND state = 'pending'
  `);
  return await getSplitGroup(dbc, groupId);
}

// ── Per-lane terminal outcomes ──────────────────────────────────────────────

// A lane resolved to zero recipients. Terminal + benign: it does NOT burn as
// `schedule_missed_at` (which renders Red "needs attention") and it SATISFIES the
// group so its two siblings can still release. Tier-3 severity — an informational
// note, not an alert.
export async function markLaneSkippedEmpty(
  dbc: DbOrTx,
  stageId: number,
): Promise<void> {
  await dbc.execute(sql`
    UPDATE campaign_stages
    SET skipped_empty_at = now()
    WHERE id = ${stageId}::int
      AND sent_at IS NULL
      AND skipped_empty_at IS NULL
  `);
}

// A lane hit a permanent refusal. The whole group is dead: no lane releases.
// Tier-1 severity — this needs a human.
export async function failSplitGroup(
  dbc: DbOrTx,
  groupId: string,
  reason: string,
): Promise<void> {
  await dbc.execute(sql`
    UPDATE campaign_stage_split_groups
    SET state = 'failed', last_error = ${reason}
    WHERE id = ${groupId}::uuid AND state <> 'failed'
  `);
}

// ── Settle: flip materializing → materialized once every lane is done ───────
//
// "Done" = fully materialized (`materialized_at` set) OR skipped empty. Any lane
// still outstanding leaves the group in 'materializing' and Phase B keeps holding
// the trio. Guarded on `state = 'materializing'` so it can never resurrect a
// 'failed' group.
//
// Returns true when this call flipped the group to 'materialized'.
export async function settleSplitGroup(
  dbc: DbOrTx,
  groupId: string,
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    UPDATE campaign_stage_split_groups g
    -- Clearing last_error matters: it is the stuck-sweep's post-once marker, so a
    -- group that was flagged stuck and then finished must not stay flagged.
    SET state = 'materialized', last_error = NULL
    WHERE g.id = ${groupId}::uuid
      AND g.state = 'materializing'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_stages s
        WHERE s.split_group_id = g.id
          AND s.archived_at IS NULL
          AND s.materialized_at IS NULL
          AND s.skipped_empty_at IS NULL
      )
    RETURNING g.id
  `)) as unknown as { id: string }[];
  return rows.length > 0;
}

// ── Per-group stuck detector ────────────────────────────────────────────────
//
// A group that never leaves 'materializing' holds its siblings' already-written
// rows UNRELEASED forever, and nothing else would ever say so. That is the worst
// failure mode this design can have — silent non-delivery — so it gets its own
// alarm. Trips when ALL of:
//
//   * state = 'materializing'
//   * at least one non-archived lane is still outstanding (neither materialized
//     nor skipped-empty)
//   * now is more than SPLIT_GROUP_STUCK_MS past the LAST lane's due time
//
// MEASURED FROM THE LAST LANE'S DUE TIME, not from recomputed_at — and that is
// load-bearing. Lanes are created with `scheduled_at = null` and the operator
// sets each one's time SEPARATELY, so a group legitimately sits in
// 'materializing' from the first lane's slot until the last one's. Anchoring on
// recomputed_at would fire on every normal staggered split. A lane whose
// scheduled_at was never set contributes no due time, so the clock runs from the
// last lane that DOES have one — which is exactly the "you never scheduled lane
// 3" case we want flagged.
//
// It ALERTS, it does not auto-fail. Failing the group would discard real work and
// could itself cause the non-delivery it is meant to catch; a human decides.
// `last_error` doubles as the post-once marker so the sweep can't re-alert every
// 5 minutes; settleSplitGroup clears it.
export const SPLIT_GROUP_STUCK_MS = 60 * 60 * 1000;
const STUCK_MARKER = "stuck_materializing";

export async function sweepStuckSplitGroups(
  dbc: DbOrTx,
  opts: { now: Date; stuckMs?: number; orgId?: string; maxGroups?: number },
): Promise<{ stuck: number }> {
  const stuckMs = opts.stuckMs ?? SPLIT_GROUP_STUCK_MS;
  const cutoffSeconds = Math.floor(stuckMs / 1000);
  const nowIso = opts.now.toISOString();

  const rows = (await dbc.execute(sql`
    UPDATE campaign_stage_split_groups g
    SET last_error = ${STUCK_MARKER}
    WHERE g.id IN (
      SELECT g2.id
      FROM campaign_stage_split_groups g2
      JOIN campaigns c ON c.id = g2.campaign_id
      WHERE g2.state = 'materializing'
        AND g2.last_error IS DISTINCT FROM ${STUCK_MARKER}
        AND EXISTS (
          SELECT 1 FROM campaign_stages s
          WHERE s.split_group_id = g2.id
            AND s.archived_at IS NULL
            AND s.materialized_at IS NULL
            AND s.skipped_empty_at IS NULL
        )
        AND ${nowIso}::timestamptz > (
          GREATEST(
            g2.recomputed_at,
            COALESCE(
              (SELECT max(s.scheduled_at) FROM campaign_stages s
               WHERE s.split_group_id = g2.id AND s.archived_at IS NULL),
              g2.recomputed_at
            )
          ) + make_interval(secs => ${cutoffSeconds})
        )
        ${opts.orgId ? sql`AND c.org_id = ${opts.orgId}::uuid` : sql``}
      LIMIT ${opts.maxGroups ?? 25}
    )
    RETURNING g.id::text AS id
  `)) as unknown as { id: string }[];

  for (const r of rows) {
    void notifyGroupStuck(dbc, r.id).catch(() => {});
  }
  return { stuck: rows.length };
}

// ── Provisional preview (the confirm modal) ─────────────────────────────────
//
// "If we split right now, how big would each lane be?" — the source scope plus a
// per-tier count, computed LIVE off the campaign-wide high-water tier.
//
// PROVISIONAL, and the UI must say so: these numbers move until the lanes
// materialize. Tier is read live, and the source set is re-derived at recompute
// time (a stage that completes in between widens it).
//
// Measured cost on production (2026-08-27): 1.0–3.5s for the widest campaigns
// (worst case 6 stages / 9,999 contacts / 39,372 links = 3,500ms). Fine behind a
// button; NOT fine inline in a list — which is why the stages list still defers
// its lane counts to /stages/lane-counts.
//
// Deliberately does NOT apply the content-dedup exclusion layers, matching the
// existing lane-count preview (computeLaneAudienceCountsBatch). That known
// preview-vs-send gap is tracked separately — folding it in here would make this
// preview disagree with the lane counts shown on the very next screen.
export interface SplitLanePreview {
  can_split: boolean;
  reason: string | null;
  source_stages: { id: number; stage_number: number; label: string | null; sent_at: string }[];
  anchor_stage_id: number | null;
  // Distinct contacts who received ANY source stage, after opt-out suppression.
  source_contacts: number;
  // Per-tier lane counts. `converted` exits the sequence (no lane) and is shown
  // so the operator can see why the lanes don't sum to source_contacts.
  lanes: { tier: number; label: string; count: number }[];
  converted_excluded: number;
  opted_out_excluded: number;
}

const TIER_LABEL: Record<number, string> = {
  0: "Ignored",
  1: "Clicked",
  2: "Reached offer",
};

export async function previewSplitLanes(
  dbc: DbOrTx,
  campaignId: number,
  orgId: string,
): Promise<SplitLanePreview> {
  const sources = await resolveCompletedStages(dbc, campaignId, orgId);
  const empty: SplitLanePreview = {
    can_split: false,
    reason: "no_completed_stages",
    source_stages: [],
    anchor_stage_id: null,
    source_contacts: 0,
    lanes: [0, 1, 2].map((t) => ({ tier: t, label: TIER_LABEL[t], count: 0 })),
    converted_excluded: 0,
    opted_out_excluded: 0,
  };
  if (sources.length === 0) return empty;

  const ids = sources.map((s) => Number(s.id));
  const idArray = sql`array[${sql.join(
    ids.map((i) => sql`${i}::int`),
    sql`, `,
  )}]::int[]`;

  const rows = (await dbc.execute(sql`
    with tier_map as materialized (
      ${campaignTierExpr(campaignId, orgId)}
    ),
    source as (
      select distinct ss.contact_id
      from stage_sends ss
      where ss.campaign_id = ${campaignId}::int
        and ss.org_id = ${orgId}::uuid
        and ss.status = 'sent'
        and ss.stage_id = any (${idArray})
    ),
    classified as (
      select src.contact_id,
             coalesce(t.tier, 0) as tier,
             exists (
               select 1 from opt_outs oo
               where oo.contact_id = src.contact_id and oo.org_id = ${orgId}::uuid
             ) as opted_out
      from source src
      left join tier_map t on t.contact_id = src.contact_id
    )
    select
      count(*) filter (where not opted_out)                        as source_contacts,
      count(*) filter (where opted_out)                            as opted_out_excluded,
      count(*) filter (where not opted_out and tier = 3)           as converted_excluded,
      count(*) filter (where not opted_out and tier = 0)           as t0,
      count(*) filter (where not opted_out and tier = 1)           as t1,
      count(*) filter (where not opted_out and tier = 2)           as t2
    from classified
  `)) as unknown as Record<string, string | number>[];
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);

  return {
    can_split: true,
    reason: null,
    source_stages: sources,
    anchor_stage_id: Number(sources[sources.length - 1].id),
    // source_contacts is POST-opt-out, so lanes + converted == source_contacts.
    source_contacts: n("source_contacts"),
    lanes: [0, 1, 2].map((t) => ({
      tier: t,
      label: TIER_LABEL[t],
      count: n(`t${t}`),
    })),
    converted_excluded: n("converted_excluded"),
    opted_out_excluded: n("opted_out_excluded"),
  };
}

// ── T−N recompute sweep (driven by the send-preflight cron) ─────────────────
//
// Every split group with a lane entering the lead window gets its source set
// resolved here, ~15 min before Phase A would materialize it. Attaching to
// send-preflight rather than the fire path is deliberate: that cron already
// leads each send-scheduled tick by exactly one lead time, is read-mostly, is
// per-stage best-effort, and carries the operator abort — so a slow or erroring
// recompute costs a group its lead time, never its fire window (Phase A's lazy
// ensureGroupSourceResolved is the backstop).
//
// NOTE this deliberately does NOT ride on `preflight_notified_at`. That column
// is a POST-ONCE marker for the Telegram digest; overloading it would mean a
// group whose digest already went out could never be recomputed.
//
// Selection mirrors the preflight cron's own gates (approved, active campaign,
// not aborted/held/missed/already-materialized) so we never resolve a group for
// a lane that is not actually going to fire.
export async function recomputeDueSplitGroups(
  dbc: DbOrTx,
  opts: { now: Date; leadMs: number; orgId?: string; maxGroups?: number },
): Promise<{ considered: number; resolved: number; failed: number }> {
  const nowIso = opts.now.toISOString();
  const leadIso = new Date(opts.now.getTime() + opts.leadMs).toISOString();
  const maxGroups = opts.maxGroups ?? 50;

  const due = (await dbc.execute(sql`
    SELECT DISTINCT g.id AS group_id
    FROM campaign_stage_split_groups g
    JOIN campaign_stages s ON s.split_group_id = g.id
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE g.state = 'pending'
      AND c.link_mode = 'tracked'
      AND c.status = 'active'
      AND (c.send_paused IS NOT TRUE)
      AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL
      AND s.scheduled_at <= ${leadIso}
      AND s.materialized_at IS NULL
      AND s.sent_at IS NULL
      AND s.schedule_missed_at IS NULL
      AND s.skipped_empty_at IS NULL
      AND s.slip_hold_at IS NULL
      AND s.preflight_aborted_at IS NULL
      AND s.archived_at IS NULL
      ${opts.orgId ? sql`AND c.org_id = ${opts.orgId}` : sql``}
    LIMIT ${maxGroups}
  `)) as unknown as { group_id: string }[];

  // `nowIso` is referenced so the query's intent (a window anchored at now) stays
  // explicit even though only the upper bound is filtered — a lane already PAST
  // due must still be resolved, so there is no lower bound by design.
  void nowIso;

  let resolved = 0;
  let failed = 0;
  for (const r of due) {
    let group: SplitGroupRow | null = null;
    try {
      group = await ensureGroupSourceResolved(dbc, r.group_id);
    } catch {
      continue; // best-effort per group — one failure never blocks the tick
    }
    if (group?.state === "materializing") resolved++;
    else if (group?.state === "failed") {
      failed++;
      void notifyGroupFailed(dbc, r.group_id, group.last_error ?? "recompute_failed").catch(
        () => {},
      );
    }
  }
  return { considered: due.length, resolved, failed };
}

// ── Operator-facing alerts ──────────────────────────────────────────────────

interface GroupAlertContext {
  campaign: string;
  campaignId: number;
  lanes: number;
  recomputedAt: string | null;
}

async function groupAlertContext(
  dbc: DbOrTx,
  groupId: string,
): Promise<GroupAlertContext> {
  const rows = (await dbc.execute(sql`
    SELECT c.name AS campaign, c.id AS campaign_id, g.recomputed_at AS recomputed_at,
           (SELECT count(*)::int FROM campaign_stages s
            WHERE s.split_group_id = g.id AND s.archived_at IS NULL) AS lanes
    FROM campaign_stage_split_groups g
    JOIN campaigns c ON c.id = g.campaign_id
    WHERE g.id = ${groupId}::uuid
    LIMIT 1
  `)) as unknown as {
    campaign: string | null;
    campaign_id: number;
    recomputed_at: string | null;
    lanes: number;
  }[];
  const r = rows[0];
  return {
    campaign: r?.campaign ?? "(unknown campaign)",
    campaignId: Number(r?.campaign_id ?? 0),
    lanes: Number(r?.lanes ?? 0),
    recomputedAt: r?.recomputed_at ?? null,
  };
}

// Tier 1 — the group will not fire and a human must act.
export async function notifyGroupFailed(
  dbc: DbOrTx,
  groupId: string,
  reason: string,
): Promise<void> {
  const ctx = await groupAlertContext(dbc, groupId);
  await notifyTelegram(
    `🛑 Behavioural split FAILED — no lane will send.\n` +
      `Campaign "${ctx.campaign}" (id ${ctx.campaignId}) · ${ctx.lanes} lane${ctx.lanes === 1 ? "" : "s"}\n` +
      `Reason: ${reason}\n` +
      `All lanes are held unreleased. Rows already materialized are kept — cancel the ` +
      `stages to clear them. Action needed: resolve the cause, then re-prepare.`,
  );
}

// Tier 1 — the group has been stuck mid-materialization long past its last lane's
// slot. Its siblings' rows are written but held, so this is silent non-delivery
// until a human acts.
export async function notifyGroupStuck(
  dbc: DbOrTx,
  groupId: string,
): Promise<void> {
  const ctx = await groupAlertContext(dbc, groupId);
  const outstanding = (await dbc.execute(sql`
    SELECT s.stage_number, s.label, s.scheduled_at
    FROM campaign_stages s
    WHERE s.split_group_id = ${groupId}::uuid
      AND s.archived_at IS NULL
      AND s.materialized_at IS NULL
      AND s.skipped_empty_at IS NULL
    ORDER BY s.stage_number
  `)) as unknown as {
    stage_number: number | null; label: string | null; scheduled_at: string | null;
  }[];
  const list = outstanding
    .map(
      (s) =>
        `  · stage ${s.stage_number ?? "?"}${s.label ? ` "${s.label}"` : ""} — ` +
        (s.scheduled_at ? `due ${s.scheduled_at}` : "NO SEND TIME SET"),
    )
    .join("\n");
  await notifyTelegram(
    `🛑 Behavioural split STUCK — lanes materialized but NOT sending.\n` +
      `Campaign "${ctx.campaign}" (id ${ctx.campaignId})\n` +
      `The group has been mid-materialization well past its last lane's slot, so ` +
      `every lane is held unreleased. Outstanding:\n${list || "  (none listed)"}\n` +
      `Action needed: set a send time on any lane missing one, or cancel the split. ` +
      `Nothing is auto-failed — the messages already prepared are intact.`,
  );
}

// Tier 3 — informational. An empty tier is a normal outcome, so this must not
// read like a failure.
export async function notifyLaneSkippedEmpty(
  dbc: DbOrTx,
  stageId: number,
): Promise<void> {
  const rows = (await dbc.execute(sql`
    SELECT c.name AS campaign, s.stage_number AS stage_number,
           s.label AS label, s.behavioral_tier AS tier
    FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId}::int LIMIT 1
  `)) as unknown as {
    campaign: string | null;
    stage_number: number | null;
    label: string | null;
    tier: number | null;
  }[];
  const r = rows[0];
  const tierName =
    r?.tier === 0 ? "Ignored" : r?.tier === 1 ? "Clicked" : r?.tier === 2 ? "Reached offer" : "lane";
  await notifyTelegram(
    `ℹ️ Behavioural lane skipped — 0 recipients (normal for a small audience).\n` +
      `Campaign "${r?.campaign ?? "(unknown)"}" · stage ${r?.stage_number ?? stageId} · ${tierName}\n` +
      `Its sibling lanes are unaffected and will send as scheduled.`,
  );
}
