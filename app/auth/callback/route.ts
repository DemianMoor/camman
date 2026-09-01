import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { invites, org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { requestIp, requestUserAgent, writeAuditLog } from "@/lib/audit";
import { recordLogin } from "@/lib/auth/record-login";
import {
  resolveAllowlist,
  verifyWorkspaceIdentity,
} from "@/lib/auth/workspace-gate";

// OAuth / email-confirmation landing point.
//
// This is where the Google Workspace gate is enforced (ClickUp 869et3vm1
// Phase 1). Supabase will happily create a session for ANY Google account once
// the provider is enabled — it does not know about our domain restriction — so
// this route is the only thing standing between "has a Google account" and
// "is in CamMan". A session that fails the gate is signed out here, before the
// redirect, so no unauthorized session ever reaches a protected page.
//
// The gate applies to GOOGLE identities. An email/password identity reaching
// this route is the existing owner break-glass flow (or an email confirmation)
// and keeps its previous behaviour, with the deactivation check added.
// Password sign-in is separately restricted to owners in the login action —
// see app/(auth)/login/actions.ts.

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const origin = request.nextUrl.origin;
  const ip = requestIp(request);
  const userAgent = requestUserAgent(request);

  const deny = async (reason: string) => {
    // Always tear the session down before bouncing. Leaving it alive would let
    // the user simply navigate to /dashboard and be let in by a later request
    // that never re-runs this gate.
    const supabase = await createClient();
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
  };

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=verification_failed", origin),
    );
  }

  const supabase = await createClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(
      new URL("/login?error=verification_failed", origin),
    );
  }

  // Re-read the user from the server rather than trusting the exchange result:
  // getUser() validates the token against Supabase Auth.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return await deny("verification_failed");

  const isGoogle =
    user.app_metadata?.provider === "google" ||
    (user.identities ?? []).some((i) => i.provider === "google");

  if (isGoogle) {
    const identity = verifyWorkspaceIdentity(user);
    if (!identity.ok) {
      // No org context yet — this user may belong to no org at all — so the
      // refusal is logged to the server, not to audit_log (which requires an
      // org_id). The Users screen shows denied attempts for KNOWN members via
      // the allowlist branch below.
      console.warn("[auth] Google sign-in refused", {
        reason: identity.reason,
        email: user.email,
      });
      return await deny("not_authorized");
    }

    const allow = await resolveAllowlist(user.id, identity.email);

    if (allow.status === "denied") {
      console.warn("[auth] Google sign-in not allow-listed", {
        email: identity.email,
      });
      return await deny("not_authorized");
    }

    if (allow.status === "member") {
      if (!allow.isActive) {
        await writeAuditLog({
          orgId: allow.orgId,
          actorUserId: user.id,
          action: "auth.login_denied",
          entityType: "org_member",
          entityId: user.id,
          summary: `${identity.email} attempted to sign in while deactivated`,
          metadata: { method: "google", reason: "membership_inactive" },
          ip,
          userAgent,
        });
        return await deny("deactivated");
      }
    } else {
      // First sign-in against an open invite: provision the membership and
      // burn the invite in one transaction, so a failure cannot leave a
      // consumed invite with no membership (or the reverse).
      await db.transaction(async (tx) => {
        await tx.insert(org_members).values({
          user_id: user.id,
          org_id: allow.orgId,
          role: allow.role,
          invited_email: identity.email,
          invited_at: new Date(),
          is_active: true,
        });
        await tx
          .update(invites)
          .set({ accepted_at: new Date() })
          .where(
            and(eq(invites.id, allow.inviteId), eq(invites.org_id, allow.orgId)),
          );
      });

      await writeAuditLog({
        orgId: allow.orgId,
        actorUserId: user.id,
        action: "user.joined",
        entityType: "org_member",
        entityId: user.id,
        summary: `${identity.email} joined as ${allow.role} via invite`,
        metadata: { role: allow.role, invite_id: allow.inviteId },
        ip,
        userAgent,
      });
    }

    // An identity LINK lands here exactly like a sign-in — same code exchange,
    // same user, and by now the same Google identity on the account. The only
    // thing that distinguishes them is the marker the link action put on its
    // redirect URL.
    //
    // Note this runs AFTER the workspace gate above, so a link is subject to
    // the same hd/domain rules as a login: linking a personal Google account to
    // an owner account is refused for the same reason signing in with one is.
    if (request.nextUrl.searchParams.get("linked") === "google") {
      await writeAuditLog({
        orgId: allow.orgId,
        actorUserId: user.id,
        action: "auth.google_linked",
        entityType: "org_member",
        entityId: user.id,
        summary: `Linked the Google account ${identity.email} to this login`,
        metadata: { google_email: identity.email },
        ip,
        userAgent,
      });
    }

    await recordLogin({
      orgId: allow.orgId,
      userId: user.id,
      email: identity.email,
      method: "google",
      ip,
      userAgent,
    });

    return NextResponse.redirect(new URL("/dashboard", origin));
  }

  // Non-Google identity (owner break-glass / email confirmation). No org row
  // yet is normal here — /auth/complete handles first-time setup.
  const membership = await db
    .select({
      org_id: org_members.org_id,
      is_active: org_members.is_active,
    })
    .from(org_members)
    .where(eq(org_members.user_id, user.id))
    .limit(1);

  if (membership[0]) {
    if (!membership[0].is_active) {
      await writeAuditLog({
        orgId: membership[0].org_id,
        actorUserId: user.id,
        action: "auth.login_denied",
        entityType: "org_member",
        entityId: user.id,
        summary: `${user.email ?? user.id} attempted to sign in while deactivated`,
        metadata: { method: "password", reason: "membership_inactive" },
        ip,
        userAgent,
      });
      return await deny("deactivated");
    }
    await recordLogin({
      orgId: membership[0].org_id,
      userId: user.id,
      email: user.email ?? null,
      method: "password",
      ip,
      userAgent,
    });
  }

  return NextResponse.redirect(new URL("/dashboard", origin));
}
