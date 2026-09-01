import "server-only";

import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { audit_log } from "@/db/schema";

// Account / authz / compliance audit trail (migration 0175, ClickUp 869et3vm1).
//
// SCOPE — this table is NOT a second campaign_events. campaign_events keeps
// owning campaign-scoped history (status transitions, sends, stage deletes)
// and is already written by 19 routes; do not duplicate those rows here.
// audit_log owns the events that have no campaign to hang off: logins, user
// activation/deactivation, role changes, cap hits, rejected URLs, deletion
// requests and approvals.
//
// BEST-EFFORT BY CONTRACT, like lib/alerts/telegram.ts: a failure to write an
// audit row must never break the action being audited. A login that succeeds
// and then 500s because the audit insert failed is strictly worse than a login
// that succeeds unaudited.
//
// ⚠️ THE RETURN VALUE IS THE ONLY SIGNAL. Because this swallows failures, a
// caller that needs to know the trail exists has nothing else to read. Most
// callers are right to ignore it. But anything that LATCHES or SUPPRESSES on
// "we recorded this" must check the boolean — the same rule that made
// lib/alerts/alert-state.ts check notifyTelegram's result.

export type AuditAction =
  // Phase 1 — authentication and account lifecycle
  | "auth.login"
  | "auth.login_denied"
  | "auth.login_new_ip"
  // An existing password account gained a Google identity. Distinct from
  // auth.login because it is a change to HOW the account can authenticate, not
  // an instance of authenticating — and it is the event an Owner would want to
  // see if it happened without them.
  | "auth.google_linked"
  | "user.invited"
  | "user.invite_revoked"
  | "user.joined"
  | "user.role_changed"
  | "user.activated"
  | "user.deactivated"
  | "user.sessions_revoked"
  | "stage.auto_paused";

export interface AuditInput {
  orgId: string;
  actorUserId?: string | null;
  action: AuditAction;
  summary: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Write one audit row. NEVER THROWS.
 *
 * @returns `true` only when the row was actually inserted.
 */
export async function writeAuditLog(input: AuditInput): Promise<boolean> {
  try {
    await db.insert(audit_log).values({
      org_id: input.orgId,
      actor_user_id: input.actorUserId ?? null,
      action: input.action,
      summary: input.summary,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      metadata: input.metadata ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
    });
    return true;
  } catch (err) {
    // Log and move on. Never rethrow — see the contract above.
    console.error("[audit] failed to write audit row", {
      action: input.action,
      orgId: input.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Request context ────────────────────────────────────────────────────────
//
// ⚠️ x-forwarded-for is a COMMA-SEPARATED LIST when more than one proxy is in
// front of us, and the CLIENT-controlled portion is on the LEFT. On Vercel the
// rightmost entries are appended by the platform, so the leftmost value is
// spoofable. We store the leftmost anyway because for an audit trail "what the
// client claimed" is the useful datum, and we are not making a security
// decision from it — unlike lib/links/resolve-click.ts, which needs
// CF-Connecting-IP precisely because it IS making a scoring decision.
//
// Callers must therefore never treat audit_log.ip as authenticated. The
// "login from a new IP" alert is a prompt for a human to look, not a control.

export function requestIp(req: Request | NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

export function requestUserAgent(req: Request | NextRequest): string | null {
  const ua = req.headers.get("user-agent");
  // Bound it: a UA is attacker-controlled free text and this column is read
  // into an Owner-facing table.
  return ua ? ua.slice(0, 512) : null;
}
