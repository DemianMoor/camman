"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatCampaignDateTime,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type {
  LifecycleMetrics,
  LifecycleOutsideBasis,
  LifecycleReport,
} from "@/lib/reporting/lifecycle-report";

type Report = LifecycleReport & {
  rollup_computed_at: string | null;
  live_days: number;
  outside_basis: LifecycleOutsideBasis;
};
import { cn } from "@/lib/utils";

// Row order and copy. `suppressed` is shown with a DASH and a note rather than
// a zero: it is structurally empty — suppressed contacts are excluded from
// audiences by construction — and a 0 would read as a measurement nobody made.
const ROW_LABEL: Record<string, string> = {
  new: "New",
  cold: "Cold",
  hot: "Hot",
  warm_31_60: "Warm 31–60",
  warm_61_120: "Warm 61–120",
  warm: "Warm (no click time)",
  freeze: "Freeze",
  suppressed: "Suppressed",
  clickers: "Clickers (hot + warm)",
  non_clickers: "Non-clickers",
  total: "Total",
  unclassified: "Unclassified",
  drip: "Drip",
  grand_total: "Grand total",
};
const ROW_ORDER = [
  "new", "cold", "hot", "warm_31_60", "warm_61_120", "warm", "freeze", "suppressed",
  "clickers", "non_clickers", "total", "unclassified", "drip", "grand_total",
];
const RULE_BEFORE = new Set(["clickers", "total", "unclassified", "grand_total"]);
const EMPHASIS = new Set(["total", "grand_total"]);
// Metric cells per row — the suppressed row prints one dash per column.
const METRIC_COLUMNS = 14;
// Rows hidden when empty: a warm stamp with no click time exists only until the
// last_click_at backfill reaches it, and a zero row there would read as data.
const HIDE_WHEN_EMPTY = new Set(["warm"]);

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);
const money = (v: string) =>
  `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => v.toLocaleString();
const moneyOrDash = (v: number | null) => (v === null ? "—" : money(String(v)));
const roiPct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

export function LifecycleReport() {
  // Lazy initialisers: reading the clock in the render body is impure, and the
  // default period must not shift under a re-render.
  const [from, setFrom] = useState(() =>
    formatInCampaignTimezone(new Date(Date.now() - 6 * 86_400_000), "yyyy-MM-dd"),
  );
  const [to, setTo] = useState(() =>
    formatInCampaignTimezone(new Date(), "yyyy-MM-dd"),
  );
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useApiCall<Report>();

  useEffect(() => {
    void (async () => {
      const res = await api.execute(
        `/api/reports/lifecycle?from=${from}&to=${to}`,
      );
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setData(null);
        setError(res.error);
      }
    })();
  }, [api.execute, from, to]);

  const rows = data?.rows ?? [];
  const byRow = new Map(rows.map((r) => [r.row as string, r]));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="lc-from">From</Label>
          <Input
            id="lc-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="lc-to">To</Label>
          <Input
            id="lc-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <span className="pb-2 text-xs text-muted-foreground">
          ET dates, max 92 days · by send date
        </span>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Cohort</th>
                <th className="px-3 py-2 text-right font-medium">Sends</th>
                <th className="px-3 py-2 text-right font-medium">Clickers</th>
                <th className="px-3 py-2 text-right font-medium">CTR</th>
                <th className="px-3 py-2 text-right font-medium">New clickers</th>
                <th className="px-3 py-2 text-right font-medium">Sales*</th>
                <th className="px-3 py-2 text-right font-medium">Purchases*</th>
                <th className="px-3 py-2 text-right font-medium">CR*</th>
                <th className="px-3 py-2 text-right font-medium">Revenue*</th>
                <th className="px-3 py-2 text-right font-medium">EPC*</th>
                <th className="px-3 py-2 text-right font-medium">Opt-out</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">CPC</th>
                <th className="px-3 py-2 text-right font-medium">ROI</th>
                <th className="px-3 py-2 text-right font-medium">Cost / new clicker</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {ROW_ORDER.map((key) => {
                const r: LifecycleMetrics | undefined = byRow.get(key);
                if (HIDE_WHEN_EMPTY.has(key) && !(r && r.sends > 0)) return null;
                const suppressed = key === "suppressed";
                const emphasis = EMPHASIS.has(key);
                return (
                  <tr
                    key={key}
                    className={cn(
                      "border-b last:border-0",
                      RULE_BEFORE.has(key) && "border-t-2",
                      emphasis && "font-medium",
                      suppressed && "text-muted-foreground",
                    )}
                  >
                    <td className="px-3 py-2 text-left">
                      {ROW_LABEL[key]}
                      {suppressed ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          excluded by construction
                        </span>
                      ) : null}
                      {r?.reconstructed ? (
                        <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                          reconstructed
                        </span>
                      ) : null}
                    </td>
                    {/* Suppressed shows a dash across every metric — it is
                        structurally empty, and a 0 would read as a measurement. */}
                    {suppressed ? (
                      <>
                        {Array.from({ length: METRIC_COLUMNS }).map((_, i) => (
                          <td key={i} className="px-3 py-2 text-right">—</td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right">{num(r?.sends ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.clickers ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{pct(r?.ctr ?? null)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.new_clickers ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.sales ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.purchases ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{pct(r?.cr ?? null)}</td>
                        <td className="px-3 py-2 text-right">{money(r?.revenue ?? "0")}</td>
                        <td className="px-3 py-2 text-right">{moneyOrDash(r?.epc ?? null)}</td>
                        <td className="px-3 py-2 text-right">
                          {num(r?.opt_outs ?? 0)}
                          {r?.opt_out_rate != null ? (
                            <span className="ml-1 text-muted-foreground">
                              ({pct(r.opt_out_rate)})
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">{money(r?.cost ?? "0")}</td>
                        <td className="px-3 py-2 text-right">{moneyOrDash(r?.cpc ?? null)}</td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right",
                            r?.roi != null && r.roi < 0 && "text-destructive",
                          )}
                        >
                          {roiPct(r?.roi ?? null)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {!r || r.new_clickers === 0 ? (
                            "—"
                          ) : r.pays_for_itself ? (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              pays for itself
                            </span>
                          ) : (
                            moneyOrDash(r.cost_per_new_clicker)
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {api.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : null}

      {/* ⚠️ THE FOOTER IS LOAD-BEARING. Every line here exists because a number
          above it is otherwise read as something it is not. */}
      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium">*By send date.</span> Sales, Purchases,
          CR, Revenue and EPC count the conversions on the sends in this period —
          each conversion is matched to the send whose link was clicked, whenever
          it arrives. So a conversion that arrives later still counts on its
          send&apos;s day, and one that arrives in this period on an earlier send
          is not in the rows above.
        </p>
        {data?.outside_basis ? (
          <p>
            <span className="font-medium">Not in the rows above:</span>{" "}
            {money(data.outside_basis.earlier_sends_revenue)} revenue (
            {num(data.outside_basis.earlier_sends_purchases)} purchases) earned in
            this period on sends before it
            {data.outside_basis.unattributed_conversions > 0 ? (
              <>
                , and {money(data.outside_basis.unattributed_revenue)} from{" "}
                {num(data.outside_basis.unattributed_conversions)} conversions not
                tied to any send
              </>
            ) : (
              <>; every conversion in this period is tied to a send</>
            )}
            .
          </p>
        ) : null}
        <p>
          <span className="font-medium">One status per contact per day.</span>{" "}
          A contact&apos;s cohort is the status stamped when the message was
          sent, evaluated once per ET day — not per message.
        </p>
        <p>
          <span className="font-medium">CTR uses raw human clicks</span>, the
          same source the lifecycle engine evaluates against. Overview uses{" "}
          <code>counted_clickers</code>, which lags, so the two tabs show
          different CTRs for the same period.
        </p>
        <p>
          <span className="font-medium">Total is the regular-campaign cohorts
          above it; Grand total is every send in the period</span> — Total plus
          Unclassified plus Drip. Drip campaigns are one row of their own, not
          split into cohorts.
          Sales counts buyers (sends with at least one purchase); Purchases counts
          every purchase event, so a buyer who pays twice is 1 sale and 2
          purchases. ROI is (revenue − cost) ÷ cost.
        </p>
        <p>
          <span className="font-medium">Warm is split by days since the
          contact&apos;s last human click when the message was sent</span> — 31–60
          and 61–120 (Hot is 30 days or less). <span className="font-medium">New
          clickers</span> are sends whose click was the contact&apos;s first human
          click ever. <span className="font-medium">Cost / new clicker</span> is
          (cost − revenue) ÷ new clickers; it is blank with no new clickers and
          reads &quot;pays for itself&quot; when revenue exceeds cost.
        </p>
        <p>
          <span className="font-medium">Cost includes opt-out cost</span> — a
          cohort with more opt-outs costs more per send.
        </p>
        <p>
          <span className="font-medium">EPC and CPC divide by this tab&apos;s
          Clickers</span> (revenue ÷ clickers, cost ÷ clickers), not by
          Overview&apos;s Human clicks — so EPC here is not Overview&apos;s EPC.
        </p>
        <p>
          Per-recipient numbers here do not reconcile with Overview&apos;s
          totals, which come from Keitaro stage aggregates.
        </p>
        <p>
          <span className="font-medium">Closed days are read from a nightly
          rollup; today is counted live.</span>{" "}
          So today&apos;s row is current to the second, while a closed day
          reflects the last nightly recompute — which re-runs a 14-day trailing
          window, plus any older day that received a conversion or opt-out
          since the previous run, so late money still lands.
        </p>
        {data?.rollup_computed_at ? (
          <p>
            Closed days last recomputed{" "}
            <span className="font-medium">
              {formatCampaignDateTime(data.rollup_computed_at)}
            </span>
            .
          </p>
        ) : null}
        {data?.has_reconstructed ? (
          <p className="text-amber-700 dark:text-amber-400">
            <span className="font-medium">This period includes reconstructed rows.</span>{" "}
            Cohorts for sends before live stamping were rebuilt from history
            using the thresholds in force when the backfill ran. The backfill is
            run once and is not re-run after a threshold change.
          </p>
        ) : null}
      </div>
    </div>
  );
}
