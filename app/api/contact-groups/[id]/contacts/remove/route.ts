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
import { validatePhonesBatch } from "@/lib/phone-validation";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const INVALID_SAMPLE_LIMIT = 20;

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

// Bulk-remove contacts from a contact group by phone number. Removes the
// junction row only; contacts themselves are untouched.
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

  // Dedup by E.164.
  const phoneSet = new Set<string>();
  for (const v of valid) phoneSet.add(v.normalized);
  const phones = Array.from(phoneSet);

  let removed = 0;
  let notInGroup = 0;
  let notFound = 0;

  if (phones.length > 0) {
    // Resolve contact_ids for all phones in this org.
    const contactRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(
        and(eq(contacts.org_id, orgId), inArray(contacts.phone_number, phones)),
      );
    const foundPhones = new Set(contactRows.map((r) => r.phone_number));
    notFound = phones.filter((p) => !foundPhones.has(p)).length;

    if (contactRows.length > 0) {
      // Pre-check how many of these contacts are currently in the group.
      const currentlyInGroup = await db
        .select({ contact_id: contact_contact_groups.contact_id })
        .from(contact_contact_groups)
        .where(
          and(
            eq(contact_contact_groups.contact_group_id, groupId),
            eq(contact_contact_groups.org_id, orgId),
            inArray(
              contact_contact_groups.contact_id,
              contactRows.map((r) => r.id),
            ),
          ),
        );
      const inGroupIds = new Set(currentlyInGroup.map((r) => r.contact_id));
      notInGroup = contactRows.filter((r) => !inGroupIds.has(r.id)).length;

      if (inGroupIds.size > 0) {
        const deleted = await db
          .delete(contact_contact_groups)
          .where(
            and(
              eq(contact_contact_groups.contact_group_id, groupId),
              eq(contact_contact_groups.org_id, orgId),
              inArray(
                contact_contact_groups.contact_id,
                Array.from(inGroupIds),
              ),
            ),
          )
          .returning({ contact_id: contact_contact_groups.contact_id });
        removed = deleted.length;
      }
    }
  }

  return NextResponse.json({
    submitted: rawLines.length,
    valid: valid.length,
    invalid: invalid.length,
    removed,
    not_in_group: notInGroup,
    not_found: notFound,
    invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
  });
}
