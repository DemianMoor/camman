"use client";

import { Fragment, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";
import type { DeliveryProviderRow } from "@/lib/reporting/delivery";

interface DeliveryResponse {
  data: DeliveryProviderRow[];
  totals: {
    sent_all_providers: number;
    sent: number;
    delivered: number;
    undelivered: number;
    no_receipt: number;
  };
  no_dlr_note: string;
  range: { from: string; to: string; timezone: string; max_days: number };
}

// Window options. Capped at 14 days by the route — a 30-day window measures
// 11.0s against prod, which would exceed the function limit. Widening this
// needs the covering index first (ClickUp 869ehwae3).
const WINDOWS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
] as const;

function etDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const fmtInt = (n: number) => n.toLocaleString();
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

// An em dash, never "0" and never "0.0%". A non-capable provider has no delivery
// information at all; rendering it as zero reads as a total delivery failure
// across ~99.9% of platform volume.
function Dash() {
  return <span className="text-muted-foreground/60">—</span>;
}

// The five numeric cells, shared by provider rows and their number sub-rows so
// the two can never drift in formatting or in null handling.
function Cells({
  row,
  muted,
}: {
  row: Pick<
    DeliveryProviderRow,
    "sent" | "delivered" | "undelivered" | "no_receipt" | "delivered_pct"
  >;
  muted?: boolean;
}) {
  return (
    <>
      <td className={cn("px-3 py-2 text-right tabular-nums", muted && "text-muted-foreground")}>
        {fmtInt(row.sent)}
      </td>
      <td className={cn("px-3 py-2 text-right tabular-nums", muted && "text-muted-foreground")}>
        {row.delivered === null ? <Dash /> : fmtInt(row.delivered)}
      </td>
      <td className={cn("px-3 py-2 text-right tabular-nums", muted && "text-muted-foreground")}>
        {row.undelivered === null ? <Dash /> : fmtInt(row.undelivered)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {row.no_receipt === null ? <Dash /> : fmtInt(row.no_receipt)}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right font-medium tabular-nums",
          row.delivered_pct !== null && row.delivered_pct < 90 ? "text-amber-600" : "",
          muted && row.delivered_pct === null && "text-muted-foreground",
        )}
      >
        {row.delivered_pct === null ? <Dash /> : fmtPct(row.delivered_pct)}
      </td>
    </>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function DeliveryReport() {
  const [filters, updateFilters] = usePersistedFilters<{ days: number }>(
    "reports.delivery",
    { days: 7 },
  );
  const days = WINDOWS.some((w) => w.days === filters.days) ? filters.days : 7;

  const api = useApiCall<DeliveryResponse>();
  const [resp, setResp] = useState<DeliveryResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Which providers are expanded into their per-number rows. Deliberately NOT
  // persisted: the fleet glance is the default view, and a reload should return
  // to it rather than to whatever was open last week.
  const [expandedProviders, setExpandedProviders] = useState<string[]>([]);
  const toggleProvider = (key: string) =>
    setExpandedProviders((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ from: etDate(-(days - 1)), to: etDate(0) });
    (async () => {
      const result = await api.execute(`/api/reports/delivery?${params.toString()}`);
      if (cancelled) return;
      if (result.ok) {
        setResp(result.data);
        setFetchError(null);
      } else {
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Depends on api.execute, NOT api. eslint's exhaustive-deps asks for the
    // whole hook return here; including it re-runs the effect on every render
    // and produces an infinite fetch loop. Same deliberate exception as
    // components/reports/performance-report.tsx.
  }, [days, api.execute]);

  const rows = resp?.data ?? [];
  const totals = resp?.totals ?? null;
  const capableCount = rows.filter((r) => r.dlr_capable).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-1 rounded-md border p-0.5">
          {WINDOWS.map((w) => (
            <Button
              key={w.days}
              type="button"
              size="sm"
              variant={w.days === days ? "secondary" : "ghost"}
              className="h-8"
              onClick={() => updateFilters({ days: w.days })}
            >
              {w.label}
            </Button>
          ))}
        </div>
        {/* The window is labelled on the surface: figures from different windows
            are not comparable, and a percentage with no window is not a fact. */}
        {resp ? (
          <p className="text-sm text-muted-foreground">
            {resp.range.from} → {resp.range.to} ({CAMPAIGN_TIMEZONE_LABEL})
          </p>
        ) : null}
      </div>

      {totals ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Sent (all providers)" value={fmtInt(totals.sent_all_providers)} />
          <StatCard
            label="Sent (with DLR)"
            value={fmtInt(totals.sent)}
            hint={`${capableCount} of ${rows.length} providers`}
          />
          <StatCard label="Delivered" value={fmtInt(totals.delivered)} />
          <StatCard label="Undelivered" value={fmtInt(totals.undelivered)} />
          <StatCard label="No receipt" value={fmtInt(totals.no_receipt)} />
        </div>
      ) : null}

      {fetchError ? (
        <p className="text-sm text-destructive">{fetchError}</p>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Provider</th>
              <th className="px-3 py-2 text-right font-medium">Sent</th>
              <th className="px-3 py-2 text-right font-medium">Delivered</th>
              <th className="px-3 py-2 text-right font-medium">Undelivered</th>
              <th className="px-3 py-2 text-right font-medium">No receipt</th>
              <th className="px-3 py-2 text-right font-medium">Delivered %</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !api.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  No sends in this window.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => {
              // Only offer expansion where there is something to expand into.
              // A single-number provider's sub-row would just restate its parent.
              const expandable = r.numbers.length > 1;
              const open = expandable && expandedProviders.includes(r.provider_key);
              return (
                <Fragment key={r.provider_key}>
                  <tr className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {expandable ? (
                          <button
                            type="button"
                            onClick={() => toggleProvider(r.provider_key)}
                            aria-expanded={open}
                            aria-label={`${open ? "Collapse" : "Expand"} ${r.name} numbers`}
                            className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ChevronRight
                              className={cn("size-3.5 transition-transform", open && "rotate-90")}
                            />
                          </button>
                        ) : (
                          <span className="-ml-1 inline-block size-4.5" />
                        )}
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: r.color ?? "#64748B" }}
                        />
                        <span>{r.name}</span>
                        {expandable ? (
                          <span className="text-xs text-muted-foreground">
                            {r.numbers.length} numbers
                          </span>
                        ) : null}
                        {r.archived ? (
                          <span className="text-xs text-muted-foreground">(archived)</span>
                        ) : null}
                        {!r.dlr_capable ? (
                          <span
                            className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            title="This provider has no delivery-receipt intake, so delivery cannot be measured. These cells are blank rather than zero — a 0% here would be a reporting artefact, not a delivery failure."
                          >
                            {resp?.no_dlr_note ?? "no reliable DLR"}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <Cells row={r} />
                  </tr>
                  {open
                    ? r.numbers.map((n) => (
                        <tr
                          key={`${r.provider_key}:${n.provider_phone_id ?? "none"}`}
                          className="border-b bg-muted/30 last:border-0"
                        >
                          <td className="py-1.5 pl-11 pr-3">
                            <span className="inline-flex items-center gap-2">
                              <span className="font-mono text-[13px]">
                                {n.phone_number ?? "No number"}
                              </span>
                              {n.number_type ? (
                                <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                  {n.number_type.replace(/_/g, " ")}
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <Cells row={n} muted />
                        </tr>
                      ))
                    : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium">Delivered %</span> is delivered ÷ sent, over accepted
          sends. <span className="font-medium">No receipt</span> is shown separately and is never
          folded into the percentage — a recently-sent message may simply not have matured yet.
        </p>
        <p>
          Providers marked <span className="font-medium">no reliable DLR</span> have no
          delivery-receipt intake, so their delivery columns are blank rather than zero. Their
          Sent counts are still exact. Windows are not comparable with each other.
        </p>
        <p>
          Providers running more than one number expand into a per-number breakdown — two numbers
          on the same provider can differ sharply in deliverability (a short code and a toll-free
          are not the same product). Each number is attributed from the send&apos;s own record, so a
          stage whose number changed mid-send is split correctly rather than credited to one of
          them.
        </p>
      </div>
    </div>
  );
}
