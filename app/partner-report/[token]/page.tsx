import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PartnerReportView } from "@/components/reports/partner-report-view";
import { getPartnerReport, stripRevenueForPartner } from "@/lib/reporting/partner-report";
import { resolveReportToken } from "@/lib/reporting/partner-report-token";

// PUBLIC partner report (Drip Phase 7) — no login, no session.
//
// ⚠️ SCOPE COMES FROM THE TOKEN'S KEY ROW, NEVER THE URL. The only parameter is
// the token; `partnerKeyId` is whatever it resolved to, so there is nothing an
// visitor can edit to see another partner. No org data beyond their aggregates
// is fetched at all — not filtered out downstream, never queried.
//
// ⚠️ EVERY FAILURE IS THE SAME 404 — unknown, revoked, expired, archived key.
// Distinguishing them would turn this page into an oracle for which tokens once
// existed.
//
// ⚠️ noindex: a link handed to a partner must not end up in a search index.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Partner report",
  robots: { index: false, follow: false, nocache: true },
};

function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function etDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export default async function PartnerReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveReportToken(token);
  if (!resolved) notFound();

  const sp = await searchParams;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const from = DAY.test(sp.from ?? "") ? sp.from! : etDaysAgo(30);
  const to = DAY.test(sp.to ?? "") ? sp.to! : etToday();

  const report = await getPartnerReport(
    resolved.orgId,
    from > to ? to : from,
    to,
    // scope — from the key row
    resolved.partnerKeyId,
  );

  // ⭐ Stripped on the SERVER, not hidden by the component — see
  // stripRevenueForPartner. Hiding a column client-side still ships the value.
  const safe = resolved.showRevenue ? report : stripRevenueForPartner(report);

  return (
    <PartnerReportView
      token={token}
      partnerName={resolved.partnerName}
      showRevenue={resolved.showRevenue}
      report={safe}
    />
  );
}
