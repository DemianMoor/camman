import type { Metadata } from "next";

import { entityTitle } from "@/lib/entity-title";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged. The offer name alone is
// the title; "Offer Report" is only the fallback.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: await entityTitle("offer", id, "Offer Report") };
}

export default function OfferReportTitleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
