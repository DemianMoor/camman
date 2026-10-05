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
  LifecycleReport,
} from "@/lib/reporting/lifecycle-report";

type Report = LifecycleReport & {
  rollup_computed_at: string | null;
  live_days: number;
};
import { cn } from "@/lib/utils";

// Row order and copy. `suppressed` is shown with a DASH and a note rather than
// a zero: it is structurally empty — suppressed contacts are excluded from
// audiences by construction — and a 0 would read as a measurement nobody made.
const ROW_LABEL: Record<string, string> = {
  new: "New",
  cold: "Cold",
  hot: "Hot",
  warm: "Warm",
  freeze: "Freeze",
  suppressed: "Suppressed",
  clickers: "Clickers (hot + warm)",
  non_clickers: "Non-clickers",
  total: "Total",
  unclassified: "Unclassified",
};
const ROW_ORDER = [
  "new", "cold", "hot", "warm", "freeze", "suppressed",
  "clickers", "non_clickers", "total", "unclassified",
];
const RULE_BEFORE = new Set(["clickers", "total", "unclassified"]);

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);
const money = (v: string) =>
  `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => v.toLocaleString();
const moneyOrDash = (v: number | null) => (v === null ? "—" : money(String(v)));

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
          ET dates, max 92 days
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
                <th className="px-3 py-2 text-right font-medium">Sales*</th>
                <th className="px-3 py-2 text-right font-medium">CR*</th>
                <th className="px-3 py-2 text-right font-medium">Revenue*</th>
                <th className="px-3 py-2 text-right font-medium">EPC*</th>
                <th className="px-3 py-2 text-right font-medium">Opt-out</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">CPC</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {ROW_ORDER.map((key) => {
                const r: LifecycleMetrics | undefined = byRow.get(key);
                const suppressed = key === "suppressed";
                const emphasis = key === "total";
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
                        {Array.from({ length: 10 }).map((_, i) => (
                          <td key={i} className="px-3 py-2 text-right">—</td>
                        ))}
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right">{num(r?.sends ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.clickers ?? 0)}</td>
                        <td className="px-3 py-2 text-right">{pct(r?.ctr ?? null)}</td>
                        <td className="px-3 py-2 text-right">{num(r?.sales ?? 0)}</td>
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
          <span className="font-medium">*Attributed only.</span> Sales, CR,
          Revenue and EPC count conversions attributed to an individual send. Most
          conversions are not, so these read far below the true totals — a low
          CR here is an attribution gap, not performance.
        </p>
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
          window, so late clicks, conversions and opt-outs still land.
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
