"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ManualMix, derive, fmtInt, fmtPct, fmtUsd } from "@/components/reports/report-metrics";
import { SearchableSelect } from "@/components/searchable-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { ctrOfVisitors, salesPctOfReached } from "@/lib/reporting/landing-page-metrics";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";
import type { LandingPageReport as Report, LandingPageRow, LandingPageTotal } from "@/lib/reporting/landing-page-report";

type OfferOption = { id: number; name: string; status: string };
type Resp = { offers?: OfferOption[]; report?: Report };

// /reports/landing-pages — results per landing page for one offer, SEND-DATE
// basis (docs/04-features/landing-page-report.md). The offer lives in ?offer=<id>
// like Audience Stats' ?group=. The date range is NOT persisted: the page opens
// on All Time (offer created → today) every time, by decision.

const fmtRate = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

function Dash() {
  return <span className="text-muted-foreground/60">—</span>;
}

function Cells({ m, bold }: { m: LandingPageTotal; bold?: boolean }) {
  const d = derive({ sends: m.sends, revenue: m.revenue, sales: m.sales, clicks: m.clicks, cost: m.cost, optouts: m.optouts });
  const sp = salesPctOfReached(m);
  const ctr = ctrOfVisitors(m);
  const td = cn("px-3 py-2 text-right tabular-nums", bold && "font-medium");
  return (
    <>
      <td className={td}>{fmtInt(m.sends)}</td>
      <td className={td}>{d.rpm == null ? <Dash /> : fmtUsd(d.rpm)}</td>
      <td className={cn(td, d.net_rpm != null && (d.net_rpm >= 0 ? "text-emerald-600" : "text-destructive"))}>
        {d.net_rpm == null ? <Dash /> : fmtUsd(d.net_rpm)}
      </td>
      <td className={td}>{d.epc == null ? <Dash /> : fmtUsd(d.epc)}</td>
      <td className={td}>
        {fmtInt(m.clicks)}
        {m.manual_visits > 0 ? <ManualMix /> : null}
      </td>
      <td className={td}>{d.ctr == null ? <Dash /> : fmtRate(d.ctr)}</td>
      <td className={td}>{ctr == null ? <Dash /> : fmtPct(ctr)}</td>
      <td className={td}>{m.reach_covered_stages === 0 ? <Dash /> : fmtInt(m.reached)}</td>
      <td className={td}>{fmtInt(m.sales)}</td>
      <td className={td} title={m.stages.gap > 0 ? `${m.stages.gap} stage(s) with no tracker data are left out of this ratio` : undefined}>
        {sp == null ? <Dash /> : fmtPct(sp)}
      </td>
      <td className={td}>{d.oo_pct == null ? <Dash /> : fmtPct(d.oo_pct)}</td>
      <td className={cn(td, d.net_profit >= 0 ? "text-emerald-600" : "text-destructive")}>{fmtUsd(d.net_profit)}</td>
    </>
  );
}

function PageLabel({ r }: { r: LandingPageRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {r.kind === "slug" ? (
        <>
          <span>{r.title ?? r.value}</span>
          {r.title ? <span className="font-mono text-xs text-muted-foreground">{r.value}</span> : null}
          {!r.in_registry ? (
            <span
              className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              title="Sends went to this slug, but the offer's landing-page list has no page with it (renamed, or set by hand)."
            >
              not in registry
            </span>
          ) : null}
        </>
      ) : (
        <>
          <span className="text-muted-foreground">Unresolved ·</span>
          <span className="font-mono text-[13px]">{r.value}</span>
        </>
      )}
      {r.brand_name ? <span className="text-xs text-muted-foreground">· {r.brand_name}</span> : null}
    </span>
  );
}

const HEADERS: { label: string; title?: string }[] = [
  { label: "Sends" },
  { label: "RPM", title: "Revenue per 1,000 sends" },
  { label: "Net RPM", title: "(Revenue − cost) per 1,000 sends" },
  { label: "EPC", title: "Revenue ÷ visitors" },
  { label: "Visitors", title: "People with a human-scored click (or a purchase) on these sends, clicked at any time. Deduplicated per row." },
  { label: "SMS Clicked", title: "Visitors ÷ sends" },
  { label: "CTR", title: "Share of visitors who clicked the CTA and reached the advertiser page (people, deduplicated)" },
  { label: "Redirects", title: "Recipients who clicked through to the advertiser page" },
  { label: "Sales" },
  { label: "CR, %", title: "Sales ÷ redirects (recipients who reached the advertiser page) — not ÷ visitors" },
  { label: "Opt-out %", title: "Opt-outs replying to these sends ÷ sends" },
  { label: "Net Profit", title: "Revenue − cost" },
];

export function LandingPageReport({ initialOfferId }: { initialOfferId: number | null }) {
  const offersApi = useApiCall<Resp>();
  const reportApi = useApiCall<Resp>();
  const [offers, setOffers] = useState<OfferOption[] | null>(null);
  const [offerId, setOfferId] = useState<number | null>(initialOfferId);
  // null/null = All Time.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [filters, updateFilters] = usePersistedFilters<{ splitBrand: boolean }>("reports.landing-pages", {
    splitBrand: false,
  });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A slower response for an offer/range the user has moved away from must not land.
  const wanted = useRef("");

  useEffect(() => {
    void (async () => {
      const res = await offersApi.execute("/api/reports/landing-pages");
      if (res.ok) setOffers(res.data.offers ?? []);
      else setError(res.error);
    })();
    // Depends on .execute, NOT the whole hook: including it re-runs the effect on
    // every render (infinite fetch loop). Same deliberate exception as
    // components/reports/delivery-report.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offersApi.execute]);

  useEffect(() => {
    if (offerId == null) return;
    const params = new URLSearchParams({ offer_id: String(offerId) });
    if (range) {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    if (filters.splitBrand) params.set("split_brand", "1");
    const q = params.toString();
    wanted.current = q;
    void (async () => {
      const res = await reportApi.execute(`/api/reports/landing-pages?${q}`);
      if (wanted.current !== q) return;
      if (res.ok) {
        setReport(res.data.report ?? null);
        setError(null);
      } else {
        setReport(null);
        setError(res.error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- .execute only, as above
  }, [reportApi.execute, offerId, range, filters.splitBrand]);

  function pickOffer(value: string) {
    const id = Number(value);
    if (id === offerId) return;
    setOfferId(id);
    setRange(null); // All Time is anchored on the offer, so a new offer starts there
    setReport(null);
    window.history.replaceState(null, "", `?offer=${id}`);
  }

  const options = useMemo(
    () =>
      (offers ?? []).map((o) => ({
        value: String(o.id),
        label: o.status === "archived" ? `${o.name} (archived)` : o.name,
      })),
    [offers],
  );

  // The inputs show the range actually read — on All Time, the server-resolved one.
  const shownFrom = range?.from ?? report?.range.from ?? "";
  const shownTo = range?.to ?? report?.range.to ?? "";
  const zeroCost = report?.total.zero_cost_stages_with_sends ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label>Offer</Label>
          <SearchableSelect
            options={options}
            value={offerId == null ? null : String(offerId)}
            onChange={pickOffer}
            placeholder="Pick an offer"
            searchPlaceholder="Search offers…"
            emptyMessage="No offers match"
            disabled={offers == null}
            className="w-80"
            fallbackLabel={report?.offer.name}
            aria-label="Offer"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="lp-from">From</Label>
          <Input
            id="lp-from"
            type="date"
            value={shownFrom}
            max={shownTo || undefined}
            disabled={offerId == null}
            onChange={(e) => e.target.value && setRange({ from: e.target.value, to: shownTo || e.target.value })}
            className="w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="lp-to">To</Label>
          <Input
            id="lp-to"
            type="date"
            value={shownTo}
            min={shownFrom || undefined}
            disabled={offerId == null}
            onChange={(e) => e.target.value && setRange({ from: shownFrom || e.target.value, to: e.target.value })}
            className="w-40"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant={range == null ? "secondary" : "outline"}
          className="h-9"
          disabled={offerId == null}
          onClick={() => setRange(null)}
        >
          All Time
        </Button>
        <span className="pb-2 text-xs text-muted-foreground">
          Send-date basis · ET days{range == null && report ? " · from the offer's creation" : ""}
        </span>
        <Button
          type="button"
          size="sm"
          variant={filters.splitBrand ? "secondary" : "outline"}
          className="ml-auto h-9"
          onClick={() => updateFilters({ splitBrand: !filters.splitBrand })}
          aria-pressed={filters.splitBrand}
        >
          Split by brand
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {offerId == null ? (
        <p className="text-sm text-muted-foreground">Pick an offer to see how each of its landing pages has performed.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Landing page</th>
                {HEADERS.map((h) => (
                  <th key={h.label} className="px-3 py-2 text-right font-medium" title={h.title}>
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report && report.rows.length === 0 ? (
                <tr>
                  <td colSpan={HEADERS.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                    No sends for this offer in this range.
                  </td>
                </tr>
              ) : null}
              {!report && reportApi.isLoading ? (
                <tr>
                  <td colSpan={HEADERS.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : null}
              {(report?.rows ?? []).map((r) => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <PageLabel r={r} />
                  </td>
                  <Cells m={r} />
                </tr>
              ))}
              {report && report.rows.length > 0 ? (
                <tr className="border-t-2 bg-muted/30">
                  <td className="px-3 py-2 font-medium">Total · {report.offer.name}</td>
                  <Cells m={report.total} bold />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {report ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            <span className="font-medium">Send-date basis:</span> every figure belongs to the sends made in the
            selected range ({report.range.from} → {report.range.to}, ET) — sales, clicks and opt-outs that came later
            still count for the send that produced them. This differs from the Overview, which dates sales by the day
            they happened.
          </p>
          <p>
            <span className="font-medium">Total visitors do not add up</span> to the rows: a person who clicked two
            pages is one clicker for the offer and one on each page. Every other column adds up.
            {report.total.manual_visits > 0 ? (
              <>
                {" "}
                Rows marked <span className="font-medium">+manual</span>{" "}
                add manual-mode stages&apos; tracker visits,
                which are not deduplicated people.
              </>
            ) : null}
          </p>
          <p>
            <span className="font-medium">Redirects</span> are recipients who clicked through to the advertiser page;{" "}
            <span className="font-medium">CTR</span> is the share of visitors who were redirected (people, so it never passes 100%) and{" "}
            <span className="font-medium">CR, %</span> divides sales by them. All three leave out stages the tracker has
            no data for
            {report.total.stages.gap > 0 ? ` (${report.total.stages.gap} here)` : ""}.
          </p>
          {zeroCost > 0 ? (
            <p>
              <span className="font-medium">Cost coverage:</span> cost $0 on {fmtInt(zeroCost)} stage
              {zeroCost === 1 ? "" : "s"} with sends — Net RPM and Net Profit include them at $0.
            </p>
          ) : null}
          {report.unattributed_drip_conversions > 0 ? (
            <p className="text-amber-600">
              {report.unattributed_drip_conversions} drip sale(s) carry no send and could not be placed on a page; they
              are not in this table.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
