import { requirePagePermission } from "@/lib/authz/page-guard";

// Audience block — group membership is contact-level.
// Gates this whole subtree server-side; the page below is a client component
// and could not do this itself. The API routes behind it deny the operator
// independently — this is defence in depth, not the only control.
export default async function ContactGroupsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePagePermission("contact_groups.view");
  return children;
}
