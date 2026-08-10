import type { Metadata } from "next";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged.
export const metadata: Metadata = { title: "Segment Overlap" };

export default function SegmentChartsTitleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
