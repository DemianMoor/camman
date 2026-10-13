import { displayedRoi } from "@/lib/reporting/drip-daily-money";
import type { ResultRow } from "@/lib/reporting/drip-daily-results";

// The chart's line metrics, in their OWN module so the tab can build its picker
// without importing the chart (which would pull Recharts into the main bundle).
export type LineMetric = "roi" | "ctr" | "conv" | "optout" | "sends";

export const LINE_METRICS: Record<LineMetric, { label: string; pct: boolean; pick: (r: ResultRow) => number | null }> = {
  roi: { label: "ROI", pct: true, pick: (r) => displayedRoi(r.roi, r.send_cost) },
  ctr: { label: "Clicks per send", pct: true, pick: (r) => r.ctr },
  conv: { label: "Conv %", pct: true, pick: (r) => r.conv_pct },
  optout: { label: "Opt-out %", pct: true, pick: (r) => r.opt_out_pct },
  sends: { label: "Sends", pct: false, pick: (r) => r.sends },
};

