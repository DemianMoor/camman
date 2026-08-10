import type { Metadata } from "next";

import { entityTitle } from "@/lib/entity-title";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: await entityTitle("sms_provider", id, "SMS Provider") };
}

export default function ProviderDetailTitleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
