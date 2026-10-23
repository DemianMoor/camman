import type { Metadata } from "next";

import { OffersByGroupReport } from "@/components/reports/offers-by-group-report";

export const metadata: Metadata = { title: "Offers x Group" };

// /reports/offer-groups — the per-offer Group Report (same component and API as
// /offers/[id]/report), with an offer picker instead of a route param. A LITERAL
// segment, so it takes precedence over the sibling [dimension] route. The offer
// lives in ?offer=<id>, like Landing Pages.
export default async function OfferGroupsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ offer?: string }>;
}) {
  const { offer } = await searchParams;
  const id = Number(offer);
  return <OffersByGroupReport initialOfferId={Number.isInteger(id) && id > 0 ? id : null} />;
}
