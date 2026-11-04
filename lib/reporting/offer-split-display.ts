import type { EventMap } from "@/lib/reporting/event-columns";
import type { PerfMetrics } from "@/lib/reporting/performance-report";

// How a by-offer row is READ once the per-offer split has run
// (lib/reporting/offer-splits.ts). Pure, so the client table and the tests share it.
//
// An offer row's Revenue can include money another offer's traffic produced
// (split_in_revenue) and exclude money its own traffic produced on another offer
// (split_out_revenue). EVERY EPC on the row, and Profit, use the revenue the
// row's OWN traffic produced; counts and count-based rates stay as reported under
// the offer the conversion is on (like Sales). Both fields, and the per-key
// event_split_delta, are 0 / empty on every row the split did not touch, so those
// rows read exactly as before.

export const ownRevenue = (r: PerfMetrics): number =>
  r.revenue - r.split_in_revenue + r.split_out_revenue;

/** The row's event map with each key's revenue replaced by its OWN-traffic revenue — for the per-event EPC only. */
export function ownEventMap(r: Pick<PerfMetrics, "events" | "event_split_delta">): EventMap {
  const delta = r.event_split_delta ?? {};
  if (Object.keys(delta).length === 0) return r.events;
  const out: EventMap = { ...r.events };
  for (const [k, d] of Object.entries(delta)) {
    const t = out[k] ?? { n: 0, pending_n: 0, revenue: 0, pending_revenue: 0 };
    out[k] = { ...t, revenue: t.revenue + d };
  }
  return out;
}

/** A row whose only activity is conversions split in from another offer's stages: its EPCs, Profit and Cost render "—". */
export const hasNoOwnSends = (r: PerfMetrics): boolean => r.sent === 0 && r.split_in_revenue > 0;

export const NO_OWN_SENDS_NOTE =
  "This offer's sales here came through another offer's landing page, so they have no sends or cost of their own.";
