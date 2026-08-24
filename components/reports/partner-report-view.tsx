"use client";

import { useMemo, useState } from "react";

import type { PartnerReportResult, PartnerReportRow } from "@/lib/reporting/partner-report";

// The PARTNER-facing report (Drip Phase 7). Rendered on the signed link, with no
// session and no chrome from the internal app.
//
// ⚠️ INTERNAL COLUMNS ARE NOT RENDERED, and more importantly are not NEEDED:
// campaign, offer, creative and every other operational field are never
// selected by getPartnerReport in the first place. Hiding a column client-side
// would still ship it in the payload.
//
// ⚠️ REVENUE IS OFF UNLESS THE KEY SAYS OTHERWISE (ruling R2) — it is our
// margin, not the partner's number.
//
// ⚠️ NULL IS NOT ZERO. Delivered % is null when the provider reports no receipts
// at all, and CTR is null over zero sends. Both render as "—", because printing
// "0%" would read as total failure rather than "not measured".

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}
function tagLabel(t: string): string {
  return t === "" ? "(untagged)" : t;
}

function toCsv(rows: PartnerReportRow[], showRevenue: boolean): string {
  const head = [
    "interest_tag", "leads_received", "mobile", "voip", "unknown", "landline",
    "sent", "delivered_pct", "clicks", "ctr", "opt_outs", "sales", "lookup_cost_usd",
    ...(showRevenue ? ["revenue_usd"] : []),
  ];
  // ⚠️ An empty cell for a null, never "0" — the CSV carries the same
  // not-measured/measured-zero distinction the table does, or a spreadsheet
  // would average nulls in as zeroes.
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [
        tagLabel(r.interest_tag), r.leads_received, r.mobile, r.voip, r.unknown, r.landline,
        r.sent, r.delivered_pct, r.clicks, r.ctr, r.opt_outs, r.sales,
        r.lookup_cost_usd.toFixed(4),
        ...(showRevenue ? [r.revenue_usd.toFixed(2)] : []),
      ].map(cell).join(","),
    );
  }
  return lines.join("\n");
}

export function PartnerReportView({
  token,
  partnerName,
  showRevenue,
  report,
}: {
  token: string;
  partnerName: string;
  showRevenue: boolean;
  report: PartnerReportResult;
}) {
  const [from, setFrom] = useState(report.from);
  const [to, setTo] = useState(report.to);

  const totals = useMemo(() => {
    const t = report.rows.reduce(
      (a, r) => ({
        leads: a.leads + r.leads_received,
        landline: a.landline + r.landline,
        sent: a.sent + r.sent,
        clicks: a.clicks + r.clicks,
        optOuts: a.optOuts + r.opt_outs,
        sales: a.sales + r.sales,
        cost: a.cost + r.lookup_cost_usd,
        revenue: a.revenue + r.revenue_usd,
      }),
      { leads: 0, landline: 0, sent: 0, clicks: 0, optOuts: 0, sales: 0, cost: 0, revenue: 0 },
    );
    return { ...t, ctr: t.sent > 0 ? t.clicks / t.sent : null };
  }, [report.rows]);

  function downloadCsv() {
    const blob = new Blob([toCsv(report.rows, showRevenue)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `report-${report.from}-to-${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 border-b pb-4">
        <h1 className="text-xl font-semibold">{partnerName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Lead performance, {report.from} to {report.to} (Eastern Time)
        </p>
      </header>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          <span>From</span>
          <input
            type="date" name="from" value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="grid gap-1 text-xs">
          <span>To</span>
          <input
            type="date" name="to" value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm">
          Apply
        </button>
        <button
          type="button" onClick={downloadCsv}
          className="rounded-md border px-3 py-1.5 text-sm"
        >
          Download CSV
        </button>
        <span className="text-xs text-muted-foreground">
          {report.rows.length} row{report.rows.length === 1 ? "" : "s"}
        </span>
        {/* The token stays in the path; the form only ever changes the dates. */}
        <input type="hidden" name="_t" value={token.slice(0, 0)} />
      </form>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs">
            <tr>
              <th className="p-2 text-left">Tag</th>
              <th className="p-2 text-right">Leads</th>
              <th className="p-2 text-right">Mobile</th>
              <th className="p-2 text-right">VoIP</th>
              <th className="p-2 text-right">Unknown</th>
              <th className="p-2 text-right">Landline</th>
              <th className="p-2 text-right">Sent</th>
              <th className="p-2 text-right">Delivered</th>
              <th className="p-2 text-right">Clicks</th>
              <th className="p-2 text-right">CTR</th>
              <th className="p-2 text-right">Opt-outs</th>
              <th className="p-2 text-right">Sales</th>
              <th className="p-2 text-right">Lookup cost</th>
              {showRevenue && <th className="p-2 text-right">Revenue</th>}
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={showRevenue ? 14 : 13} className="p-4 text-center text-muted-foreground">
                  No leads in this period.
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr key={`${r.partner_key_id}-${r.interest_tag}`} className="border-t">
                <td className="p-2">{tagLabel(r.interest_tag)}</td>
                <td className="p-2 text-right">{r.leads_received.toLocaleString()}</td>
                <td className="p-2 text-right">{r.mobile.toLocaleString()}</td>
                <td className="p-2 text-right">{r.voip.toLocaleString()}</td>
                <td className="p-2 text-right">{r.unknown.toLocaleString()}</td>
                <td className="p-2 text-right">{r.landline.toLocaleString()}</td>
                <td className="p-2 text-right">{r.sent.toLocaleString()}</td>
                <td className="p-2 text-right">{pct(r.delivered_pct)}</td>
                <td className="p-2 text-right">{r.clicks.toLocaleString()}</td>
                <td className="p-2 text-right">{pct(r.ctr)}</td>
                <td className="p-2 text-right">{r.opt_outs.toLocaleString()}</td>
                <td className="p-2 text-right">{r.sales.toLocaleString()}</td>
                <td className="p-2 text-right">{usd(r.lookup_cost_usd)}</td>
                {showRevenue && <td className="p-2 text-right">{usd(r.revenue_usd)}</td>}
              </tr>
            ))}
          </tbody>
          {report.rows.length > 0 && (
            <tfoot className="border-t-2 bg-muted/30 font-medium">
              <tr>
                <td className="p-2">Total</td>
                <td className="p-2 text-right">{totals.leads.toLocaleString()}</td>
                <td className="p-2 text-right" colSpan={3} />
                <td className="p-2 text-right">{totals.landline.toLocaleString()}</td>
                <td className="p-2 text-right">{totals.sent.toLocaleString()}</td>
                <td className="p-2 text-right">—</td>
                <td className="p-2 text-right">{totals.clicks.toLocaleString()}</td>
                <td className="p-2 text-right">{pct(totals.ctr)}</td>
                <td className="p-2 text-right">{totals.optOuts.toLocaleString()}</td>
                <td className="p-2 text-right">{totals.sales.toLocaleString()}</td>
                <td className="p-2 text-right">{usd(totals.cost)}</td>
                {showRevenue && <td className="p-2 text-right">{usd(totals.revenue)}</td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ⚠️ The rate and its calibration window are shown so an invoice line can
          be checked by hand rather than taken on trust (ruling R1). */}
      <p className="mt-3 text-xs text-muted-foreground">
        Lookup cost is charged at {report.rate.rate.toFixed(6)} per number checked
        {report.rate.source === "ledger"
          ? `, the metered average over ${report.rate.from} to ${report.rate.to}.`
          : " (standard rate)."}
      </p>
    </main>
  );
}
