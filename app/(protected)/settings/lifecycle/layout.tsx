import type { ReactNode } from "react";

import { requirePagePermission } from "@/lib/authz/page-guard";

// The settings subtree is already gated on providers.view; this narrows THIS
// page to the permission that actually governs it, so someone who cannot change
// a threshold gets a 404 instead of a form whose every control is disabled.
export default async function LifecycleSettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requirePagePermission("lifecycle.configure");
  return <>{children}</>;
}
