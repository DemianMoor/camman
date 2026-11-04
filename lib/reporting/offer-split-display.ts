import type { PerfMetrics } from "@/lib/reporting/performance-report";

// How a by-offer row is READ once the per-offer split has run
// (lib/reporting/offer-splits.ts). Pure, so the client table and the tests share it.
//
// An offer row's Revenue can include money another offer's traffic produced
// (split_in_revenue) and exclude money its own traffic produced on another offer
// (split_out_revenue). EPC and Profit use the revenue the row's OWN traffic
// produced. Both fields are 0 on every row the split did not touch, so those rows
// read exactly as before.

export const ownRevenue = (r: PerfMetrics): number =>
  r.revenue - r.split_in_revenue + r.split_out_revenue;

/** A row whose only activity is conversions split in from another offer's stages: EPC, Profit and Cost render "—". */
export const hasNoOwnSends = (r: PerfMetrics): boolean => r.sent === 0 && r.split_in_revenue > 0;

export const NO_OWN_SENDS_NOTE =
  "This offer's sales here came through another offer's landing page, so they have no sends or cost of their own.";
