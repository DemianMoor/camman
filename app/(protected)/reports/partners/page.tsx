import type { Metadata } from "next";

import { InternalPartnerReport } from "@/components/reports/internal-partner-report";

export const metadata: Metadata = { title: "By Partner" };

// Internal partner report (Drip Phase 7). Authenticated and org-scoped by the
// route's own session; revenue always shown here, unlike the partner view.
export default function PartnersReportPage() {
  return <InternalPartnerReport />;
}
