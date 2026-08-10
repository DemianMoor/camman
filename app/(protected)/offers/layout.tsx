import type { Metadata } from "next";

import { sectionTitle } from "@/lib/page-title";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged. sectionTitle() (not a
// bare string) because this segment has titled descendants.
export const metadata: Metadata = { title: sectionTitle("Offers") };

export default function OffersTitleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
