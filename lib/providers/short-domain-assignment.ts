import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { short_domains } from "@/db/schema";

// Shared guard for assigning a short domain to a sending number (migration
// 0137). Used by BOTH the phone create and update routes so the ownership and
// status rules can't drift between them — the same reason
// lib/providers/credential-context.ts exists.
//
// Two independent checks, and both matter for different reasons:
//
//   ORG OWNERSHIP is the multi-tenancy invariant (CLAUDE.md §3). Without it a
//   caller could point their number at another org's domain by guessing an id,
//   and every link minted from that number would advertise a hostname they do
//   not control.
//
//   ACTIVE STATUS is what makes B1 safe. Brand-domain rows are inserted as
//   'pending' until an operator has proven DNS resolves to this app, and a
//   pending or archived domain must never be mintable — links minted under a
//   host that doesn't resolve are dead on arrival and the clicks are lost with
//   no error anywhere. kickoff applies the same `status = 'active'` gate at send
//   time; this stops the bad assignment being stored in the first place.

export type ShortDomainAssignmentResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_active"; message: string };

// `null` clears the override (back to the brand default) and is always allowed —
// it can only ever widen what mints successfully, never break it.
export async function verifyShortDomainAssignable(
  orgId: string,
  shortDomainId: number | null | undefined,
): Promise<ShortDomainAssignmentResult> {
  if (shortDomainId == null) return { ok: true };

  const rows = await db
    .select({ id: short_domains.id, status: short_domains.status, domain: short_domains.domain })
    .from(short_domains)
    .where(and(eq(short_domains.id, shortDomainId), eq(short_domains.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  // Not-in-org and not-existing collapse to the same answer on purpose, so the
  // endpoint can't be used to probe which domain ids exist in other orgs.
  if (!row) {
    return { ok: false, reason: "not_found", message: "That short domain doesn't belong to your organization." };
  }
  if (row.status !== "active") {
    return {
      ok: false,
      reason: "not_active",
      message: `"${row.domain}" isn't active yet. Verify it resolves to this app before assigning it to a number.`,
    };
  }
  return { ok: true };
}
