import type { Metadata } from "next";

import { LandingPageReport } from "@/components/reports/landing-page-report";

export const metadata: Metadata = { title: "Landing Pages" };

// /reports/landing-pages — results per landing page for one offer, send-date
// basis. A LITERAL segment, so it takes precedence over the sibling
// [dimension] route; its column set is its own (docs/04-features/landing-page-report.md).
export default async function LandingPagesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ offer?: string }>;
}) {
  const { offer } = await searchParams;
  const id = Number(offer);
  return <LandingPageReport initialOfferId={Number.isInteger(id) && id > 0 ? id : null} />;
}
