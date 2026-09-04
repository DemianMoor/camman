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
  | "stage.auto_paused"
  // Phase 4 — guardrails. These were ALREADY being written by
  // lib/guardrails/notify.ts, which cast past this union with `action: n.event
  // as never`. The cast is gone; the union now states the truth, so the next
  // guardrail event is a compile error here rather than a surprise in the
  // Owner's audit feed. (Verified against production: guardrail.cap_blocked and
  // guardrail.cap_exceeded rows already exist.)
  | "guardrail.cap_blocked"
  | "guardrail.url_rejected"
  | "guardrail.creative_forked"
  | "guardrail.deletion_requested"
  | "guardrail.deletion_decided"
  | "guardrail.cap_exceeded"
  | "guardrail.unproven_creative"
  | "guardrail.volume_deviation"
  | "guardrail.frequency_collision"
  // ── API tokens (ClickUp 869evpmbz) ────────────────────────────────────
  // Owner-side lifecycle.
  | "token.created"
  | "token.revoked"
  | "user.api_enabled"
  | "user.api_disabled"
  // Per-request trail. `api.request` is the high-volume one and is written on
  // every ALLOWED token request; the two failure actions are written on every
  // single occurrence and are never sampled, because they are the ones an
  // Owner investigates.
  //
  // ⚠️ `api.request` RECORDS THE AUTH OUTCOME, NOT THE HANDLER'S FINAL STATUS.
  // It is written by requireApiMembership() before the handler body runs, so
  // there is no response to read yet. Its metadata carries `outcome:
  // "allowed"`, deliberately not a `status` field that would look like an HTTP
  // code and be wrong for any request the handler later 404s or 500s.
  | "api.request"
  | "api.denied"
  | "api.rate_limited";

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

/**
 * Accepts a request OR a bare Headers.
 *
 * requireApiMembership() takes no request argument — it reads the session
 * through cookies() and, since 869evpmbz, the bearer token through headers() —
 * so the token audit path has a Headers and nothing else. Detecting on the
 * `headers` property rather than `instanceof Headers` keeps this working for
 * Next's ReadonlyHeaders, which is not guaranteed to be that exact class.
 */
type HeaderSource = Request | NextRequest | Headers;

function asHeaders(src: HeaderSource): Headers {
  return "headers" in src ? src.headers : src;
}

export function requestIp(src: HeaderSource): string | null {
  const headers = asHeaders(src);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip");
}

export function requestUserAgent(src: HeaderSource): string | null {
  const ua = asHeaders(src).get("user-agent");
  // Bound it: a UA is attacker-controlled free text and this column is read
  // into an Owner-facing table.
  return ua ? ua.slice(0, 512) : null;
}
