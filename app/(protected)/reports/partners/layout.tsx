import { requirePagePermission } from "@/lib/authz/page-guard";

// Partner intake reporting is part of the drip/partner surface, hidden from the operator.
//
// Gated on `providers.view`, which is used here as an OPERATOR DISCRIMINATOR
// rather than as a claim about providers: it is held by viewer, manager, admin
// and owner, and by no one else, so this denies exactly the operator and
// changes nothing for any existing role. Chosen over a role blacklist because a
// permission check is the codebase's one authorization idiom — but it is a
// borrowed fit, and when a second restricted role appears these surfaces should
// get a permission of their own.
//
// A layout, not a page edit: the page below is a client component and cannot
// run a server-side check itself.
export default async function ReportsPartnersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePagePermission("providers.view");
  return children;
}
