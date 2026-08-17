import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import { BrandShortDomains } from "@/components/settings/brand-short-domains";
import { requireOrgMembership } from "@/lib/auth/helpers";

export const metadata: Metadata = { title: "Short Domains" };

// The ONLY brand short-domain management surface. The brand form's single text
// field was removed: a brand may hold several domains (migration 0136), so one
// field could not express the shape, and the upsert behind it was broken by that
// same migration.
//
// Brands are fetched server-side (org-scoped) so the client component receives a
// stable list and only fetches the domains themselves.
export default async function ShortDomainsSettingsPage() {
  const { membership } = await requireOrgMembership();

  const rows = await db
    .select({ id: brands.id, name: brands.name, brand_id: brands.brand_id })
    .from(brands)
    .where(eq(brands.org_id, membership.org_id))
    .orderBy(asc(brands.id));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Short domains</h1>
        <p className="text-sm text-muted-foreground">
          The hosts tracked links mint under, per brand. A new domain is added as{" "}
          <strong>pending</strong> and mints nothing until you activate it — activate only
          after confirming the host actually reaches this app. A brand with no active
          domain cannot send tracked campaigns at all.
        </p>
      </header>

      <BrandShortDomains brands={rows} />
    </div>
  );
}
