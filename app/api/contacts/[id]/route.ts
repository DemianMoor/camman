import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { contactUpdateSchema } from "@/lib/validators/contacts";

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
  return NextResponse.json(rows[0]);
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
