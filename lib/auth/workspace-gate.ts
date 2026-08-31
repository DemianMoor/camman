import "server-only";

import { and, eq, gt, isNull } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";

import { db } from "@/db/client";
import { invites, org_members } from "@/db/schema";
import { isRole, type Role } from "@/lib/permissions";

// Google Workspace sign-in gate (ClickUp 869et3vm1, Phase 1).
//
// ⚠️ SUPABASE DOES NOT ENFORCE `hd`. Enabling the Google provider in the
// Supabase dashboard accepts ANY Google account, including personal gmail.com
// ones. The hosted-domain restriction is ours to implement, and it has to run
// server-side against the payload from supabase.auth.getUser() — never against
// anything the browser sends us.
//
// THREE INDEPENDENT CHECKS, all required (the card's rule: "Domain alone is
// not enough"):
//   1. the identity is a verified Google identity in our Workspace domain,
//   2. the email is allow-listed — an existing org_members row, or an open
//      `invites` row an Owner created,
//   3. the resulting membership is is_active.
//
// Check 3 lives in the per-request helpers (getApiMembershipRow /
// getOrgMembership), not here, because it must be re-evaluated on EVERY
// request rather than once at sign-in.

export const WORKSPACE_DOMAIN = (
  process.env.GOOGLE_ALLOWED_HD ?? "exuma.io"
).toLowerCase();

export type WorkspaceIdentityResult =
  | { ok: true; email: string }
  | { ok: false; reason: WorkspaceDenyReason; detail: string };

export type WorkspaceDenyReason =
  | "not_google"
  | "no_email"
  | "email_unverified"
  | "wrong_domain"
  | "hd_mismatch";

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Verify that a signed-in Supabase user is a Google Workspace identity in our
 * domain. Reads only the server-verified user object.
 */
export function verifyWorkspaceIdentity(user: User): WorkspaceIdentityResult {
  const providers = new Set<string>();
  if (typeof user.app_metadata?.provider === "string") {
    providers.add(user.app_metadata.provider);
  }
  for (const p of (user.app_metadata?.providers as string[] | undefined) ?? []) {
    providers.add(p);
  }
  for (const id of user.identities ?? []) providers.add(id.provider);

  if (!providers.has("google")) {
    return {
      ok: false,
      reason: "not_google",
      detail: "Sign-in did not use Google.",
    };
  }

  const email = user.email?.trim().toLowerCase();
  if (!email) {
    return {
      ok: false,
      reason: "no_email",
      detail: "Google returned no email address.",
    };
  }

  // Google always marks its own addresses verified; a false here means the
  // identity is not one Google vouches for, so it must not pass.
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  if (meta.email_verified === false) {
    return {
      ok: false,
      reason: "email_unverified",
      detail: "Google has not verified this address.",
    };
  }

  // The load-bearing check. A consumer Google account CANNOT hold an
  // @<workspace-domain> address — only the Workspace itself issues those, and
  // Google verifies them — so the address domain is the real restriction.
  if (emailDomain(email) !== WORKSPACE_DOMAIN) {
    return {
      ok: false,
      reason: "wrong_domain",
      detail: `Only ${WORKSPACE_DOMAIN} accounts may sign in.`,
    };
  }

  // The `hd` claim is Google's own Workspace marker. It is checked as a
  // CONFIRMATION, not as the primary gate, and deliberately only when present:
  // Google omits it in some flows, and treating absence as failure would lock
  // out legitimate users for a claim we do not control. Present-and-wrong is a
  // genuine mismatch and fails closed.
  const hd = typeof meta.hd === "string" ? meta.hd.toLowerCase() : null;
  if (hd !== null && hd !== WORKSPACE_DOMAIN) {
    return {
      ok: false,
      reason: "hd_mismatch",
      detail: `Account belongs to ${hd}, not ${WORKSPACE_DOMAIN}.`,
    };
  }

  return { ok: true, email };
}

export type AllowlistResult =
  | { status: "member"; orgId: string; role: Role; isActive: boolean }
  | { status: "invited"; orgId: string; role: Role; inviteId: string }
  | { status: "denied" };

/**
 * Resolve an allow-listed email to either an existing membership or an open
 * invite. Called AFTER verifyWorkspaceIdentity has passed.
 *
 * Note the asymmetry: an existing member is returned even when `is_active` is
 * false, so the caller can tell "deactivated" (a specific, explainable
 * refusal) apart from "never invited" — and so a deactivated account can never
 * be silently re-provisioned by a stale invite.
 */
export async function resolveAllowlist(
  userId: string,
  email: string,
): Promise<AllowlistResult> {
  const existing = await db
    .select({
      org_id: org_members.org_id,
      role: org_members.role,
      is_active: org_members.is_active,
    })
    .from(org_members)
    .where(eq(org_members.user_id, userId))
    .limit(1);

  if (existing[0]) {
    if (!isRole(existing[0].role)) return { status: "denied" };
    return {
      status: "member",
      orgId: existing[0].org_id,
      role: existing[0].role,
      isActive: existing[0].is_active,
    };
  }

  const open = await db
    .select({
      id: invites.id,
      org_id: invites.org_id,
      role: invites.role,
    })
    .from(invites)
    .where(
      and(
        eq(invites.email, email),
        isNull(invites.accepted_at),
        gt(invites.expires_at, new Date()),
      ),
    )
    .limit(1);

  if (open[0] && isRole(open[0].role)) {
    return {
      status: "invited",
      orgId: open[0].org_id,
      role: open[0].role,
      inviteId: open[0].id,
    };
  }

  return { status: "denied" };
}
