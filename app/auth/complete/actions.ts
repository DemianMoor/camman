"use server";

import { redirect } from "next/navigation";

import { getOrgMembership, requireUser } from "@/lib/auth/helpers";

export type CompleteSetupResult = { stillMissing: true };

export async function recheckMembershipAction(): Promise<CompleteSetupResult> {
  const user = await requireUser();
  const membership = await getOrgMembership(user.id);
  if (membership) redirect("/dashboard");
  return { stillMissing: true };
}
