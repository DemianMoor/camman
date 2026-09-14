import { ReportsTabs } from "@/components/reports/reports-tabs";

// Shared shell for the /reports section: title + tab bar over the Overview
// (Keitaro funnel), the five performance-rollup reports, Delivery and Audience
// Stats. Each tab is a child route so the URL is deep-linkable and the
// sidebar/tab active state is exact.
export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Campaign performance — the Keitaro funnel overview, per-dimension
          breakdowns (by number, offer, message, hour, and group), delivery
          receipts, and offer results per contact group.
        </p>
      </div>
      <ReportsTabs />
      {children}
    </div>
  );
}
