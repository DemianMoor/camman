import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
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
import { validatePhonesBatch } from "@/lib/phone-validation";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const INVALID_SAMPLE_LIMIT = 20;
const CHUNK_SIZE = 1000;

const bodySchema = z.object({
  phones: z
    .string()
    .min(1, "Phones field is required")
    .max(MAX_PAYLOAD_BYTES, "Payload too large (max ~5MB)"),
});

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Bulk-add contacts to a contact group via the phone-upload pattern.
// Each line is parsed as a phone, contacts are UPSERTed into the contacts
// table, then tagged in contact_contact_groups (ON CONFLICT DO NOTHING so
// re-adding an existing member is a no-op).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contact_contact_groups.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const groupId = parseId(id);
  if (groupId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const groupRows = await db
    .select({ id: contact_groups.id })
    .from(contact_groups)
    .where(
      and(eq(contact_groups.id, groupId), eq(contact_groups.org_id, orgId)),
    )
    .limit(1);
  if (!groupRows[0]) {
    return apiError(404, "Contact group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact_group",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const rawLines = parsed.data.phones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const { valid, invalid } = validatePhonesBatch(rawLines);

  // Dedup valid by normalized E.164.
  const seen = new Set<string>();
  const dedupedValid: typeof valid = [];
  for (const v of valid) {
    if (!seen.has(v.normalized)) {
      seen.add(v.normalized);
      dedupedValid.push(v);
    }
  }

  // UPSERT contacts to get their IDs back, regardless of whether they
  // pre-existed. We track contacts_created separately by pre-checking.
  const phones = dedupedValid.map((v) => v.normalized);
  const existingBefore = await db
    .select({ phone_number: contacts.phone_number })
    .from(contacts)
    .where(and(eq(contacts.org_id, orgId), inArray(contacts.phone_number, phones)));
  const existingSet = new Set(existingBefore.map((r) => r.phone_number));

  const resolved: { id: string; phone_number: string }[] = [];
  for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
    const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
      org_id: orgId,
      phone_number: v.normalized,
    }));
    if (chunk.length === 0) continue;
    const upserted = await db
      .insert(contacts)
      .values(chunk)
      .onConflictDoUpdate({
        target: [contacts.org_id, contacts.phone_number],
        set: { updated_at: drizzleSql`now()` },
      })
      .returning({ id: contacts.id, phone_number: contacts.phone_number });
    resolved.push(...upserted);
  }

  const contactsCreated = resolved.filter(
    (r) => !existingSet.has(r.phone_number),
  ).length;
  const contactsAlreadyExisted = resolved.length - contactsCreated;

  // Tag every resolved contact with this group, idempotent.
  let groupsApplied = 0;
  if (resolved.length > 0) {
    for (let i = 0; i < resolved.length; i += CHUNK_SIZE) {
      const chunk = resolved.slice(i, i + CHUNK_SIZE);
      const inserted = await db
        .insert(contact_contact_groups)
        .values(
          chunk.map((c) => ({
            contact_id: c.id,
            contact_group_id: groupId,
            org_id: orgId,
          })),
        )
        .onConflictDoNothing()
        .returning({ contact_id: contact_contact_groups.contact_id });
      groupsApplied += inserted.length;
    }
  }

  return NextResponse.json(
    {
      submitted: rawLines.length,
      valid: dedupedValid.length,
      invalid: invalid.length,
      contacts_created: contactsCreated,
      contacts_already_existed: contactsAlreadyExisted,
      groups_applied: groupsApplied,
      // PhoneUploadForm consumes `inserted` as its newly-imported count;
      // mirror the field so the shared form keeps working without bespoke
      // result-mapping per endpoint.
      inserted: contactsCreated,
      invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
    },
    { status: 201 },
  );
}
