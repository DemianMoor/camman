import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import {
  contact_contact_groups,
  contact_groups,
  contacts,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const bulkApplySchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(10_000),
  group_ids: z.array(z.number().int().positive()).min(1).max(50),
});

// Bulk-tag many contacts with many groups. Returns the count of NEW
// (contact_id, contact_group_id) pairs inserted — existing pairs are
// ignored via ON CONFLICT. Permission: operator+ (contact_contact_groups.manage).
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contact_contact_groups.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = bulkApplySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { contact_ids, group_ids } = parsed.data;
  const uniqueContacts = Array.from(new Set(contact_ids));
  const uniqueGroups = Array.from(new Set(group_ids));

  // Ownership: every contact and every group must belong to the caller's org.
  const [validContacts, validGroups] = await Promise.all([
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.org_id, orgId), inArray(contacts.id, uniqueContacts)),
      ),
    db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, uniqueGroups),
        ),
      ),
  ]);
  if (validContacts.length !== uniqueContacts.length) {
    return apiError(
      400,
      "One or more contact_ids do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "contact_ids" },
    );
  }
  if (validGroups.length !== uniqueGroups.length) {
    return apiError(
      400,
      "One or more group_ids do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "group_ids" },
    );
  }

  // Cartesian product → bulk insert with conflict-skip. Use the inserted
  // count (rows returned) as the "newly applied" tally; existing pairs
  // are silent no-ops.
  const rows: {
    contact_id: string;
    contact_group_id: number;
    org_id: string;
  }[] = [];
  for (const cid of uniqueContacts) {
    for (const gid of uniqueGroups) {
      rows.push({ contact_id: cid, contact_group_id: gid, org_id: orgId });
    }
  }

  const inserted = await db
    .insert(contact_contact_groups)
    .values(rows)
    .onConflictDoNothing()
    .returning({ contact_id: contact_contact_groups.contact_id });

  return NextResponse.json({ applied: inserted.length });
}
