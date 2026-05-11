import "server-only";

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

export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

// Uses the privileged Drizzle connection (server-side, not subject to RLS).
// Safe because we filter by the verified user's id from supabase.auth.getUser().
export async function getOrgMembership(
  userId: string,
): Promise<OrgMembership | null> {
  const rows = await db
    .select({ org_id: org_members.org_id, role: org_members.role })
    .from(org_members)
    .where(eq(org_members.user_id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireOrgMembership(): Promise<{
  user: User;
  membership: OrgMembership;
}> {
  const user = await requireUser();
  const membership = await getOrgMembership(user.id);
  if (!membership) redirect("/auth/complete");
  return { user, membership };
}
