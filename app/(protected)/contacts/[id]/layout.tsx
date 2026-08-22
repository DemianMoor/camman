import type { Metadata } from "next";

// Title-only layout: the sibling page.tsx is a client component and so cannot
// export metadata itself. Renders children unchanged. Mirrors
// app/(protected)/contact-groups/[id]/layout.tsx.
//
// The title is the plain entity name rather than the phone number: a contact
// id is a UUID, and resolving it to a phone here would mean a second query on
// every navigation for a browser-tab string.
export const metadata: Metadata = { title: "Contact" };

export default function ContactDetailTitleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
