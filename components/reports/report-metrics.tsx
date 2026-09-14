import { AlertTriangle } from "lucide-react";

import type { RawMetrics } from "@/lib/reporting/offer-group-report";

// Pure display helpers shared by the two matview-backed group reports: the
// offer report (/offers/[id]/report) and Audience Stats (/reports/audience).
// Client-safe: RawMetrics is a type-only import, so no DB code reaches the
// bundle.

// ---- formatting ----
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const int = new Intl.NumberFormat("en-US");
export const fmtUsd = (n: number | null) => (n == null ? "—" : usd.format(n));
export const fmtInt = (n: number) => int.format(n);
export const fmtNum = (n: number | null, dp = 2) => (n == null ? "—" : n.toFixed(dp));
export const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

// ---- derived ratios (uniform for every row kind) ----
export type Derived = {
  rpm: number | null;
  net_rpm: number | null;
  epc: number | null;
  net_profit: number;
  oo_pct: number | null;
};
export function derive(m: RawMetrics): Derived {
  const rpm = m.sends > 0 ? (m.revenue / m.sends) * 1000 : null;
  const net_rpm = m.sends > 0 ? ((m.revenue - m.cost) / m.sends) * 1000 : null;
  const epc = m.clicks > 0 ? m.revenue / m.clicks : null;
  const oo_pct = m.sends > 0 ? (m.optouts / m.sends) * 100 : null;
  return { rpm, net_rpm, epc, net_profit: m.revenue - m.cost, oo_pct };
}

// ---- color helpers ----
export function netRpmClass(v: number | null, breakEven: number | null) {
  return v == null || breakEven == null
    ? ""
    : v >= breakEven
      ? "text-emerald-600"
      : "text-destructive";
}
export function ooClass(v: number | null) {
  return v == null ? "" : v <= 2 ? "text-emerald-600" : v <= 3 ? "text-amber-600" : "text-destructive";
}

// Rows whose clicks mix a deduplicated contact count with Keitaro visit counts
// (manual-mode stages mint no links, so there is no set to deduplicate). Since
// migration 0132 this can only occur on the offer footer and the org benchmark:
// a group row is built from per-recipient rows, and every manual-fallback visit
// in this data sits on a stage that has none. Verified, not assumed -- of 938
// sent stages, the 22 with sends but no clickers all have zero visits.
export function ManualMix() {
  return (
    <span
      title="Includes manual-mode stages. Their clicks are Keitaro visit counts, not deduplicated contacts, so this figure mixes the two."
      className="ml-1.5 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700 align-middle dark:text-amber-500"
    >
      +manual
    </span>
  );
}

// Staleness thresholds for the "Data as of" line. The refresh cron runs twice
// daily (05:00 / 20:00 UTC), so the worst NORMAL age — just before the later
// run, having last refreshed at 05:00 — is 15h. Anything past 16h means a run
// was missed; past 26h means two were.
//
// This matters because the failure path is already covered: a refresh that
// throws alerts and returns 500. What nothing catches from the page's side is
// the job never being invoked, which leaves the previous numbers on screen,
// internally consistent and arbitrarily old. A bare timestamp does not carry
// that — 3 days ago and 6 hours ago render identically — so the age is stated
// and flagged rather than left for the reader to compute.
const STALE_WARN_HOURS = 16;
const STALE_ALERT_HOURS = 26;

function refreshAge(refreshedAt: string | null): {
  level: "fresh" | "warn" | "alert";
  note: string | null;
} {
  if (!refreshedAt) {
    return { level: "alert", note: "never refreshed" };
  }
  const hours = (Date.now() - new Date(refreshedAt).getTime()) / 3_600_000;
  if (hours > STALE_ALERT_HOURS) {
    return { level: "alert", note: `${Math.floor(hours)}h old — at least two refreshes missed` };
  }
  if (hours > STALE_WARN_HOURS) {
    return { level: "warn", note: `${Math.floor(hours)}h old — a refresh was missed` };
  }
  return { level: "fresh", note: null };
}

export function StaleBanner({ refreshedAt }: { refreshedAt: string | null }) {
  const staleness = refreshAge(refreshedAt);
  if (staleness.level === "fresh") return null;
  return (
    <p
      className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
        staleness.level === "alert"
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-500"
      }`}
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      Stale: {staleness.note}. These numbers are a snapshot, not live.
    </p>
  );
}

// Client-side CSV download (report row sets are small).
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
