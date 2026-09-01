import "server-only";

import { notFound } from "next/navigation";

import { requireOrgMembership } from "@/lib/auth/helpers";
import { can, isRole, type Permission } from "@/lib/permissions";

// Server-side page guard for route groups the operator must not reach
// (ClickUp 869et3vm1, Phase 2).
//
// ⚠️ THIS IS A REAL CONTROL, UNLIKE HIDING A NAV ITEM — but it is the SECOND
// one. The data behind these pages is already unreachable: every contact-level
// API route denies the operator in requireApiMembership(). This stops the shell
// rendering at all, so an operator who types the URL gets a 404 instead of an
// empty screen wired to endpoints that would 403.
//
// notFound() rather than a 403 page: the operator has no business knowing the
// route exists, and a 404 is the same answer they would get for a typo.
//
// Used from LAYOUTS, not pages. Nine of the ten gated pages are client
// components and cannot run a server check themselves; a layout is a server
// component regardless of what it wraps, so one small file gates a whole
// subtree without converting any page.
export async function requirePagePermission(permission: Permission) {
  const { membership } = await requireOrgMembership();
  if (!isRole(membership.role) || !can(membership.role, permission)) {
    notFound();
  }
}
