import type { Metadata } from "next";

import { LifecycleReport } from "@/components/reports/lifecycle-report";

export const metadata: Metadata = { title: "Lifecycle" };

// /reports/lifecycle — per-cohort performance by send date (PR 5). Like
// /reports/audience this is a LITERAL segment, so it takes precedence over the
// sibling [dimension] route and does not join REPORT_DIMENSIONS: its rows are
// lifecycle cohorts read from the per-send stamp, not the shared per-stage
// funnel.
export default function LifecycleReportPage() {
  return <LifecycleReport />;
}
