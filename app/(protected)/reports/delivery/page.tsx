import type { Metadata } from "next";

import { DeliveryReport } from "@/components/reports/delivery-report";

export const metadata: Metadata = { title: "Delivery" };

// /reports/delivery — delivery receipts per provider. A LITERAL segment, so it
// takes precedence over the sibling [dimension] route and does not need to join
// REPORT_DIMENSIONS (whose shared PerformanceReport column set — EPC, revenue,
// clickers — does not apply here).
export default function DeliveryReportPage() {
  return <DeliveryReport />;
}
