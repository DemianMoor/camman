import { notFound } from "next/navigation";

import { PerformanceReport } from "@/components/reports/performance-report";
import { isReportDimension } from "@/lib/reporting/report-dimensions";

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
