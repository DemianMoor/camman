import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;

  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, auth.orgId))
    .limit(1);

  if (!orgs[0]) {
    return apiError(500, "org_not_found", "org_not_found");
  }

  return NextResponse.json({
    user: {
      id: auth.user.id,
      email: auth.user.email ?? null,
    },
    org: {
      id: orgs[0].id,
      name: orgs[0].name,
      role: auth.role,
    },
  });
}
