import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PerformanceReport } from "@/components/reports/performance-report";
import {
  DIMENSION_TAB_LABEL,
  isReportDimension,
} from "@/lib/reporting/report-dimensions";

// Pure constant lookup against DIMENSION_TAB_LABEL — no DB access, so this adds
// no query on top of the page render. An unknown dimension 404s in the page
// below; the generic title is only ever seen by the not-found response.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ dimension: string }>;
}): Promise<Metadata> {
  const { dimension } = await params;
  return {
    title: isReportDimension(dimension)
      ? DIMENSION_TAB_LABEL[dimension]
      : "Reports",
  };
}

// One route for all five performance reports: /reports/number, /reports/offer,
// /reports/sequence, /reports/hourly, /reports/group. Next 16 — params is async.
export default async function ReportDimensionPage({
  params,
}: {
  params: Promise<{ dimension: string }>;
}) {
  const { dimension } = await params;
  if (!isReportDimension(dimension)) notFound();
  return <PerformanceReport dimension={dimension} />;
}
