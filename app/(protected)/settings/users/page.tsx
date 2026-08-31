import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireOrgMembership } from "@/lib/auth/helpers";
import { can, isRole } from "@/lib/permissions";
import { UsersPanel } from "@/components/settings/users-panel";
import { WORKSPACE_DOMAIN } from "@/lib/auth/workspace-gate";

export const metadata: Metadata = { title: "User Management" };

// Owner-only member management (ClickUp 869et3vm1, Phase 1).
//
// The server check here is the REAL gate for the page — the sidebar's
// `permission` field only hides the link. notFound() rather than a 403 page so
// the route's existence is not confirmed to a role that may not access it.
// Every /api/users/* route re-checks independently; neither layer trusts the
// other.
export default async function UsersSettingsPage() {
  const { membership } = await requireOrgMembership();
  if (!isRole(membership.role) || !can(membership.role, "users.manage")) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          User Management
        </h1>
        <p className="text-sm text-muted-foreground">
          Invite people at <strong>@{WORKSPACE_DOMAIN}</strong>, set their role,
          and cut access. Deactivating someone revokes their sessions and
          un-approves every stage they created that has not sent yet — those
          stages stay un-approved until an owner re-approves them.
        </p>
      </header>

      <UsersPanel />
    </div>
  );
}
