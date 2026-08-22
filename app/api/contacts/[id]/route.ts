import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  contact_attributes,
  contact_contact_groups,
  contact_groups,
  contacts,
  opt_outs,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { contactUpdateSchema } from "@/lib/validators/contacts";
import { ageBandFromDob, ageFromDob } from "@/lib/contact-attributes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return apiError(400, "Invalid contact id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Contact not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact",
    });
  }

  // Attributes (0147) + group membership + suppression state, for the detail
  // page. Separate small queries rather than one wide LEFT JOIN: groups are
  // 1:N, so joining would fan the contact row out and every scalar would need
  // de-duplicating. Each of these is an indexed single-key lookup.
  const [attrRows, groupRows, optOutRows] = await Promise.all([
    db
      .select()
      .from(contact_attributes)
      .where(
        and(
          eq(contact_attributes.contact_id, id),
          eq(contact_attributes.org_id, orgId),
        ),
      )
      .limit(1),
    db
      .select({ id: contact_groups.id, name: contact_groups.name, color: contact_groups.color })
      .from(contact_contact_groups)
      .innerJoin(
        contact_groups,
        eq(contact_groups.id, contact_contact_groups.contact_group_id),
      )
      .where(
        and(
          eq(contact_contact_groups.contact_id, id),
          eq(contact_contact_groups.org_id, orgId),
        ),
      ),
    db
      .select({ reason: opt_outs.reason, created_at: opt_outs.created_at })
      .from(opt_outs)
      .where(and(eq(opt_outs.contact_id, id), eq(opt_outs.org_id, orgId)))
      .limit(5),
  ]);

  const attrs = attrRows[0] ?? null;
  return NextResponse.json({
    ...rows[0],
    // null (not {}) when the contact has no attributes row — the page shows
    // "no attributes recorded" rather than a grid of blanks, and the two
    // states are genuinely different.
    attributes: attrs,
    // Derived at READ time, never stored — the same rule the age_band segment
    // rule follows. Anchored to the ET calendar date, matching the send path.
    age: attrs?.dob ? ageFromDob(attrs.dob) : null,
    age_band: attrs?.dob ? ageBandFromDob(attrs.dob) : null,
    groups: groupRows,
    opt_outs: optOutRows,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return apiError(400, "Invalid contact id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updates: Record<string, unknown> = {
    updated_at: drizzleSql`now()`,
  };
  if (parsed.data.is_archived !== undefined) {
    updates.is_archived = parsed.data.is_archived;
    updates.archived_at = parsed.data.is_archived ? drizzleSql`now()` : null;
  }

  const updated = await db
    .update(contacts)
    .set(updates)
    .where(and(eq(contacts.id, id), eq(contacts.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Contact not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact",
    });
  }
  return NextResponse.json(updated[0]);
}

// Hard delete. Manager+ only. There's no RLS DELETE policy on contacts; the
// Drizzle connection bypasses RLS, so we enforce org_id filtering at the
// application layer (project rule).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return apiError(400, "Invalid contact id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const deleted = await db
    .delete(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.org_id, orgId)))
    .returning({ id: contacts.id });

  if (!deleted[0]) {
    return apiError(404, "Contact not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact",
    });
  }
  return NextResponse.json({ ok: true, id: deleted[0].id });
}
