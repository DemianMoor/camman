import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { partnerKeyUpdateSchema } from "@/lib/validators/partner-keys";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Full detail for ONE key, including its `token`.
 *
 * The token is deliberately absent from the list endpoint and present here: the
 * list is a page an admin leaves open, while fetching one key is a deliberate
 * act ("show me the URL to give this partner"). It is half the credential, so
 * it should not sit in a response that renders on every settings visit.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  // The token is a credential half, so viewing it needs manage, not view.
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { keyId: raw } = await params;
  const keyId = parseId(raw);
  if (keyId === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "keyId" });

  const rows = await db
    .select()
    .from(partner_keys)
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .limit(1);
  if (!rows[0]) {
    return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner_key" });
  }
  // The hash is never useful to a client and is not shown.
  return NextResponse.json({ ...rows[0], secret_hash: undefined });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { keyId: raw } = await params;
  const keyId = parseId(raw);
  if (keyId === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "keyId" });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = partnerKeyUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: parsed.error.issues[0]?.path.join("."),
    });
  }
  const input = parsed.data;

  const existing = await db
    .select()
    .from(partner_keys)
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .limit(1);
  if (!existing[0]) {
    return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner_key" });
  }

  // ⚠️ Cross-field validation against the MERGED result, not the patch alone.
  // Patching only interest_tag_mode='force' on a key whose stored tag is NULL
  // would otherwise slip past the Zod refinement (which sees no interest_tag in
  // the payload) and be caught by the DB CHECK as an opaque 500. Same class of
  // bug as a PATCH literal that silently drops fields it does not list.
  const mode = input.interest_tag_mode ?? existing[0].interest_tag_mode;
  const tag = input.interest_tag !== undefined ? input.interest_tag : existing[0].interest_tag;
  if (mode === "force" && !tag?.trim()) {
    return apiError(
      400,
      "An interest tag is required when the mode is 'force'",
      API_ERROR_CODES.VALIDATION,
      { field: "interest_tag" },
    );
  }

  const updated = await db
    .update(partner_keys)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.interest_tag_mode !== undefined ? { interest_tag_mode: input.interest_tag_mode } : {}),
      ...(input.interest_tag !== undefined ? { interest_tag: input.interest_tag } : {}),
      ...(input.field_mapping !== undefined ? { field_mapping: input.field_mapping } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      ...(input.rate_per_sec !== undefined ? { rate_per_sec: input.rate_per_sec } : {}),
      ...(input.rate_per_day !== undefined ? { rate_per_day: input.rate_per_day } : {}),
      ...(input.max_payload_bytes !== undefined ? { max_payload_bytes: input.max_payload_bytes } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .returning();

  return NextResponse.json({ ...updated[0], secret_hash: undefined, token: undefined });
}

// No DELETE. lead_inbox.partner_key_id is ON DELETE RESTRICT, so a key with any
// captured lead cannot be removed anyway — and it should not be: the leads
// carry its slug as provenance. Disable it instead (status='disabled'), which
// the intake endpoint answers with a 403 telling the partner exactly that.
// Same reasoning as no-DELETE on offer landing pages in Phase 1.
