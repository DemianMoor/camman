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
export const getOrgMembership = cache(
  async (userId: string): Promise<OrgMembership | null> => {
    const rows = await db
      .select({ org_id: org_members.org_id, role: org_members.role })
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
  return { user, membership };
}
