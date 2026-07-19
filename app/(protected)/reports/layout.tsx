import { ReportsTabs } from "@/components/reports/reports-tabs";

// Shared shell for the /reports section: title + tab bar over the Overview
// (Keitaro funnel) and the five performance-rollup reports. Each tab is a child
// route so the URL is deep-linkable and the sidebar/tab active state is exact.
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
          Campaign performance — the Keitaro funnel overview plus per-dimension
          breakdowns (by number, offer, message, hour, and group) from the send
          rollup.
        </p>
      </div>
      <ReportsTabs />
      {children}
    </div>
  );
}
