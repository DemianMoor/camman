import { requirePagePermission } from "@/lib/authz/page-guard";

// Drip/partner surfaces are hidden from the operator; why-not-routed is a phone -> contact lookup.
// Gates this whole subtree server-side; the page below is a client component
// and could not do this itself. The API routes behind it deny the operator
// independently — this is defence in depth, not the only control.
export default async function DripLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePagePermission("campaigns.drain");
  return children;
}
