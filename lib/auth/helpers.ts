import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { db } from "@/db/client";
import { org_members } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";

export type OrgMembership = {
  org_id: string;
  role: string;
  is_active: boolean;
};

// Wrapped in React.cache so the Supabase Auth round-trip is made at most once
// per server request, no matter how many components/helpers call getUser()
// during a single render. Behavior is identical to an un-memoized call — the
// cache scope is one request; it never bleeds across requests/users.
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

// Uses the privileged Drizzle connection (server-side, not subject to RLS).
// Safe because we filter by the verified user's id from supabase.auth.getUser().
// Memoized per request (keyed by userId) so repeated membership resolutions in
// one render hit the DB once.
// `is_active` rides along in the query that already resolves org_id + role, so
// the per-request deactivation check is free. See the twin note in
// lib/api/helpers.ts — that one covers every API route, this one every page.
export const getOrgMembership = cache(
  async (userId: string): Promise<OrgMembership | null> => {
    const rows = await db
      .select({
        org_id: org_members.org_id,
        role: org_members.role,
        is_active: org_members.is_active,
      })
      .from(org_members)
      .where(eq(org_members.user_id, userId))
      .limit(1);
    return rows[0] ?? null;
  },
);

export async function requireOrgMembership(): Promise<{
  user: User;
  membership: OrgMembership;
}> {
  const user = await requireUser();
  const membership = await getOrgMembership(user.id);
  if (!membership) redirect("/auth/complete");
  // ⚠️ MUST NOT be /login. Their Supabase session is still valid at this
  // point, and proxy.ts redirects any authenticated user away from /login and
  // /signup back to /dashboard — which lands here again. That is an infinite
  // redirect loop, not a login page. /auth/deactivated is outside
  // AUTH_PAGE_PREFIXES, so it renders, explains, and offers sign-out (which a
  // Server Component cannot do itself: cookie writes from a page render are
  // swallowed by lib/supabase/server.ts's setAll catch).
  if (!membership.is_active) redirect("/auth/deactivated");
  return { user, membership };
}
