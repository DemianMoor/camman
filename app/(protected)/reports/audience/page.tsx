import type { Metadata } from "next";

import { AudienceReport } from "@/components/reports/audience-report";

export const metadata: Metadata = { title: "Audience Stats" };

// /reports/audience — offer results per contact group (ClickUp 869eydqn0). A
// LITERAL segment, so it takes precedence over the sibling [dimension] route
// and does not join REPORT_DIMENSIONS (its rows and columns come from the offer
// group report matviews, not the shared per-stage funnel).
//
// The selected group is ?group=<id>. It is read here (Next 16: searchParams is
// async) so the client component needs no useSearchParams/Suspense boundary.
export default async function AudienceReportPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[] }>;
}) {
  const { group } = await searchParams;
  const id = Number(Array.isArray(group) ? group[0] : group);
  return <AudienceReport initialGroupId={Number.isInteger(id) && id > 0 ? id : null} />;
}
