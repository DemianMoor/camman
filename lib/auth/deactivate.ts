import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, org_members } from "@/db/schema";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { logCampaignEvent } from "@/lib/campaign-events";

// The deactivation kill switch (ClickUp 869et3vm1, Phase 1).
//
// Three things happen, in this order, and the ORDER IS THE POINT:
//
//   1. is_active = false        — takes effect on the very NEXT request,
//                                 because getApiMembershipRow/getOrgMembership
//                                 re-read it every time.
//   2. revoke refresh tokens    — stops the session being renewed.
//   3. auto-pause their unsent  — the "time bomb" defence: a departing user
//      scheduled stages           may have scheduled sends for after they go.
//
// Step 1 FIRST is deliberate. Revoking tokens does not invalidate an
// already-issued access token — Supabase JWTs stay valid until they expire —
// so token revocation alone leaves a window in which the user is still fully
// authorized. Flipping is_active closes that window immediately, and doing it
// before revocation means there is no instant at which the account is
// unrevoked AND active.
//
// ⚠️ STEP 3 DOES NOT TOUCH THE SEND PATH. It clears the EXISTING
// `send_approved` gate that the drain already checks, rather than adding any
// new condition to materialize or fire. Stabilise-first: the drain's predicate
// is unchanged, we are only changing data it already reads.

export interface DeactivationResult {
  stagesPaused: number;
  pausedStageIds: number[];
  sessionsRevoked: boolean;
}

/**
 * Pause every stage the user created that has not sent yet.
 *
 * Predicate: `send_approved = true` AND `sent_at IS NULL`. Approved-and-unsent
 * is exactly the set that would still fire on its own.
 *
 * ⚠️ `sent_at` is NEVER written here. It is the scheduler's atomic fire-lock —
 * a second writer stamping it silently cancels a scheduled send (a real past
 * bug in this codebase). Un-approving is the reversible, single-writer way to
 * stop a stage, and an Owner re-approves to undo it.
 */
export async function pauseUnsentStagesCreatedBy(
  orgId: string,
  userId: string,
  actorUserId: string | null,
): Promise<{ count: number; ids: number[] }> {
  const paused = await db
    .update(campaign_stages)
    .set({ send_approved: false })
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        eq(campaign_stages.created_by_user_id, userId),
        eq(campaign_stages.send_approved, true),
        isNull(campaign_stages.sent_at),
      ),
    )
    .returning({
      id: campaign_stages.id,
      campaign_id: campaign_stages.campaign_id,
      stage_number: campaign_stages.stage_number,
    });

  // One campaign_events row per stage so the pause shows up on the campaign's
  // own activity timeline, which is where an Owner reviewing a campaign will
  // actually look. The audit_log row (written by the caller) is the
  // account-level record of the same act; both are wanted, for two audiences.
  for (const stage of paused) {
    await logCampaignEvent(db, {
      orgId,
      campaignId: stage.campaign_id,
      stageId: stage.id,
      eventType: "stage_auto_paused",
      actorUserId,
      summary: `Stage ${stage.stage_number} un-approved automatically: its creator was deactivated`,
      metadata: { reason: "creator_deactivated", deactivated_user_id: userId },
    });
  }

  return { count: paused.length, ids: paused.map((s) => s.id) };
}

/**
 * Count what `pauseUnsentStagesCreatedBy` WOULD pause, without pausing it.
 * Used to warn the Owner before they confirm a deactivation.
 */
export async function countUnsentStagesCreatedBy(
  orgId: string,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        eq(campaign_stages.created_by_user_id, userId),
        eq(campaign_stages.send_approved, true),
        isNull(campaign_stages.sent_at),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Full kill switch. Safe to re-run: every step is idempotent.
 */
export async function deactivateMember(opts: {
  orgId: string;
  targetUserId: string;
  actorUserId: string;
  targetLabel: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<DeactivationResult> {
  const { orgId, targetUserId, actorUserId, targetLabel } = opts;

  // 1. Flip the flags first — see the ordering note above.
  //
  // api_enabled goes off in the SAME statement (ClickUp 869evpmbz): deactivating
  // someone must imply "and their robot too". is_active alone would already stop
  // every token — resolveApiToken() reads both columns in one query — so this is
  // belt-and-braces, but it is the half that SURVIVES REACTIVATION. Without it,
  // restoring an account would silently restore API access as well, and the
  // Owner would be re-granting a capability they never revisited. Same principle
  // as step 3: reactivation restores the account, not the things that were armed
  // when it was cut.
  await db
    .update(org_members)
    .set({ is_active: false, api_enabled: false })
    .where(
      and(
        eq(org_members.org_id, orgId),
        eq(org_members.user_id, targetUserId),
      ),
    );

  // 2. Revoke refresh tokens. Best-effort: if Supabase Admin is unreachable we
  //    must NOT abort, because step 1 has already cut access on our side and
  //    step 3 still has to run. A half-applied kill switch that stops requests
  //    but leaves scheduled sends armed is the worst outcome.
  let sessionsRevoked = false;
  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.signOut(targetUserId, "global");
    sessionsRevoked = !error;
    if (error) {
      console.error("[deactivate] session revocation failed", {
        targetUserId,
        error: error.message,
      });
    }
  } catch (err) {
    console.error("[deactivate] session revocation threw", {
      targetUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Disarm anything they left scheduled.
  const { count, ids } = await pauseUnsentStagesCreatedBy(
    orgId,
    targetUserId,
    actorUserId,
  );

  await writeAuditLog({
    orgId,
    actorUserId,
    action: "user.deactivated",
    entityType: "org_member",
    entityId: targetUserId,
    summary:
      `Deactivated ${targetLabel}; ` +
      `${count} unsent stage${count === 1 ? "" : "s"} auto-paused; ` +
      `sessions ${sessionsRevoked ? "revoked" : "NOT revoked"}`,
    metadata: {
      sessions_revoked: sessionsRevoked,
      stages_paused: count,
      paused_stage_ids: ids,
    },
    ip: opts.ip,
    userAgent: opts.userAgent,
  });

  return { stagesPaused: count, pausedStageIds: ids, sessionsRevoked };
}

/**
 * Re-activate. Deliberately does NOT re-approve the stages the kill switch
 * paused: un-pausing a send is a decision an Owner makes per stage, with the
 * campaign in front of them, not a side effect of restoring an account.
 */
export async function reactivateMember(opts: {
  orgId: string;
  targetUserId: string;
  actorUserId: string;
  targetLabel: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await db
    .update(org_members)
    .set({ is_active: true })
    .where(
      and(
        eq(org_members.org_id, opts.orgId),
        eq(org_members.user_id, opts.targetUserId),
      ),
    );

  await writeAuditLog({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "user.activated",
    entityType: "org_member",
    entityId: opts.targetUserId,
    summary: `Reactivated ${opts.targetLabel}. Stages paused by the kill switch stay un-approved.`,
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
}
