import type { Metadata } from "next";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged.
export const metadata: Metadata = { title: "Sign In" };

export default function LoginTitleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
