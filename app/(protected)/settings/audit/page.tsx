import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireOrgMembership } from "@/lib/auth/helpers";
import { can, isRole } from "@/lib/permissions";
import { AuditLogPanel } from "@/components/settings/audit-log-panel";

export const metadata: Metadata = { title: "Audit Log" };

// Owner-only audit feed (869et3vm1 Phase 4).
//
// Server-checked here, and the API re-checks `audit.view` independently. The
// /settings layout already denies the operator, so this is the third layer —
// deliberately, because a record OF someone is exactly the thing they would
// most want to reach.
export default async function AuditPage() {
  const { membership } = await requireOrgMembership();
  if (!isRole(membership.role) || !can(membership.role, "audit.view")) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">
          Every account, authorization and guardrail event, newest first.
          Campaign-level history (status changes, sends, stage deletes) lives on
          each campaign&apos;s own activity timeline.
        </p>
      </header>
      <AuditLogPanel />
    </div>
  );
}
