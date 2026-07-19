// Client-safe report dimension constants — NO server imports (unlike
// performance-report.ts, which pulls in the DB client). Safe to import from
// client components (the tab bar, the report component, the page router).

export const REPORT_DIMENSIONS = [
  "number",
  "offer",
  "sequence",
  "hourly",
  "group",
] as const;
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];

// Column header for the grouping dimension (singular).
export const DIMENSION_LABEL: Record<ReportDimension, string> = {
  number: "Number",
  offer: "Offer",
  sequence: "Message",
  hourly: "Hour",
  group: "Group",
};

// Tab label in the /reports tab bar.
export const DIMENSION_TAB_LABEL: Record<ReportDimension, string> = {
  number: "By Number",
  offer: "By Offer",
  sequence: "By Sequence",
  hourly: "Hourly",
  group: "By Group",
};

export function isReportDimension(v: string | null | undefined): v is ReportDimension {
  return v != null && (REPORT_DIMENSIONS as readonly string[]).includes(v);
}
