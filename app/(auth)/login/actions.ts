"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_DOMAIN } from "@/lib/auth/workspace-gate";
import { loginSchema, type LoginInput } from "@/lib/validators/auth";

export type SignInResult =
  | { ok: true; redirectTo: string }
  | { error: string };

export async function signInAction(
  input: LoginInput,
  next?: string,
): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) return { error: error.message };

  // Password sign-in is OWNER-ONLY break-glass (ClickUp 869et3vm1 §1: "Operator:
  // Google sign-in only (no password)"). Enforced here, after authentication,
  // because the role is not known until the user is identified.
  //
  // The session is torn down on refusal — leaving it alive would make the
  // restriction cosmetic, since the next request would find a valid session and
  // let them straight in.
  const user = data.user;
  if (user) {
    const rows = await db
      .select({ role: org_members.role, is_active: org_members.is_active })
      .from(org_members)
      .where(eq(org_members.user_id, user.id))
      .limit(1);

    const member = rows[0];
    if (member) {
      if (!member.is_active) {
        await supabase.auth.signOut();
        return { error: "Your access has been deactivated." };
      }
      if (member.role !== "owner") {
        await supabase.auth.signOut();
        return {
          error: "Password sign-in is not available for this account. Use Sign in with Google.",
        };
      }
    }
    // No membership row: a brand-new account mid-setup. /auth/complete handles
    // it, and it has no role to restrict yet.
  }

  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return { ok: true, redirectTo: safeNext };
}

/**
 * Start the Google Workspace OAuth flow. Redirects to Google; the gate runs on
 * the way back in app/auth/callback/route.ts.
 */
export async function signInWithGoogleAction(next?: string): Promise<{ error: string }> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    return { error: "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set" };
  }

  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : null;
  const callback = new URL("/auth/callback", siteUrl);
  if (safeNext) callback.searchParams.set("next", safeNext);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callback.toString(),
      queryParams: {
        // ⚠️ CONVENIENCE ONLY, NOT A CONTROL. `hd` tells Google's account
        // chooser to prefer our Workspace, which spares the user picking from
        // their personal accounts. It is a URL parameter, so anyone can change
        // it, and Google does not treat it as a hard restriction either. The
        // real domain check runs server-side on the callback against the
        // verified identity — see lib/auth/workspace-gate.ts.
        hd: WORKSPACE_DOMAIN,
        prompt: "select_account",
      },
    },
  });

  if (error) return { error: error.message };
  if (!data.url) return { error: "Could not start Google sign-in." };

  redirect(data.url);
}
