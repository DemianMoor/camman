"use client";

import { useEffect, useState } from "react";

import { PartnerReportView } from "@/components/reports/partner-report-view";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type { PartnerReportResult } from "@/lib/reporting/partner-report";

// Internal view — the SAME table component the partner sees, with revenue on
// and every partner included. One renderer, so the two views cannot drift into
// disagreeing about a number; what differs is the DATA the server sends, not
// the formatting.

function etDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export function InternalPartnerReport() {
  const [from, setFrom] = useState(etDay(30));
  const [to, setTo] = useState(etDay(0));
  const [report, setReport] = useState<PartnerReportResult | null>(null);
  const api = useApiCall<PartnerReportResult>();
  const run = api.execute;

  // The setState lives in the async callback, not the effect body — the same
  // shape DripConfigPanel uses, and what react-hooks/set-state-in-effect wants.
  useEffect(() => {
    (async () => {
      const r = await run(`/api/reports/partners?from=${from}&to=${to}`);
      if (r.ok) setReport(r.data);
    })();
  }, [run, from, to]);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="rounded-md border px-2 py-1 text-sm" />
        </label>
        <label className="grid gap-1 text-xs">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 className="rounded-md border px-2 py-1 text-sm" />
        </label>
        {api.isLoading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>
      {report && (
        <PartnerReportView
          token="" partnerName="All partners" showRevenue report={report}
        />
      )}
    </div>
  );
}
