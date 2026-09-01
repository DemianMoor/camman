import { requirePagePermission } from "@/lib/authz/page-guard";

// Audience block — contact rows and per-contact detail.
// Gates this whole subtree server-side; the page below is a client component
// and could not do this itself. The API routes behind it deny the operator
// independently — this is defence in depth, not the only control.
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePagePermission("contacts.view");
  return children;
}
