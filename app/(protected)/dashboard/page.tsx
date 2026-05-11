import { eq } from "drizzle-orm";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { requireOrgMembership } from "@/lib/auth/helpers";

export default async function DashboardPage() {
  const { user, membership } = await requireOrgMembership();

  const orgRows = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, membership.org_id))
    .limit(1);
  const orgName = orgRows[0]?.name ?? "Unknown organization";

  return (
    <main className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome to Campaign Manager. We&apos;ll fill this in over the coming
          weeks.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>Signed in as {user.email}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">Your organization</span>
            <span className="font-medium">{orgName}</span>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">Your role</span>
            <span className="font-medium">{membership.role}</span>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
