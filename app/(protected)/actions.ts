"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_DOMAIN } from "@/lib/auth/workspace-gate";

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// ── Link a Google identity to the signed-in account (869et3vm1 Phase 2) ────
//
// Owner-only, and SELF-ONLY: there is no target parameter, because
// linkIdentity() acts on whoever is signed in. Nobody can link an identity to
// somebody else's account through this.
//
// WHY THIS EXISTS. The owner's account is a password identity on
// demmoor@proton.me, and it is the FK target for ~400 campaigns and ~7,000
// campaign_events. Creating a second account for demian@exuma.io would orphan
// all of it; linking keeps one auth.users row, so `created_by_user_id` needs no
// rewrite at all.
//
// ⚠️ REQUIRES A SUPABASE DASHBOARD TOGGLE. Manual linking is OFF by default:
// Authentication → Sign In / Providers → "Allow manual linking". Without it
// this returns "Manual linking is disabled" and nothing happens. Automatic
// linking does NOT cover this case — it only fires when the two identities
// share an email address, and here they deliberately do not.
export async function linkGoogleIdentityAction(): Promise<{ error: string } | never> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const rows = await db
    .select({ role: org_members.role })
    .from(org_members)
    .where(eq(org_members.user_id, user.id))
    .limit(1);
  if (rows[0]?.role !== "owner") {
    return { error: "Only an owner can link a Google account." };
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) return { error: "NEXT_PUBLIC_SITE_URL is not set." };

  const { data, error } = await supabase.auth.linkIdentity({
    provider: "google",
    options: {
      // `linked=google` is how the callback tells a LINK from an ordinary
      // sign-in: both arrive as an OAuth code for a user who now has a Google
      // identity, and the two are otherwise indistinguishable at that point.
      redirectTo: `${siteUrl}/auth/callback?linked=google`,
      queryParams: { hd: WORKSPACE_DOMAIN, prompt: "select_account" },
    },
  });
  if (error) return { error: error.message };
  if (!data?.url) return { error: "Could not start Google linking." };
  redirect(data.url);
}
