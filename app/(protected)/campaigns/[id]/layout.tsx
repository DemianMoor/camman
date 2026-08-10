import type { Metadata } from "next";

import { entityTitle } from "@/lib/entity-title";
import { sectionTitle } from "@/lib/page-title";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged. sectionTitle() (not a
// bare string) because this segment has a titled descendant (/edit).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: sectionTitle(await entityTitle("campaign", id, "Campaign")) };
}

export default function CampaignDetailTitleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
