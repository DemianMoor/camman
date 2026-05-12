import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { validatePhonesBatch } from "@/lib/phone-validation";
import { contactBulkUploadSchema } from "@/lib/validators/contacts";

const CHUNK_SIZE = 1000;
const INVALID_SAMPLE_LIMIT = 20;

export type UploadResultSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
};

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = contactBulkUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Split by newline / comma / semicolon, trim, drop empties.
  const rawLines = parsed.data.phones
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const submitted = rawLines.length;

  const { valid, invalid } = validatePhonesBatch(rawLines);

  // Dedup valid by normalized E.164, preserving first occurrence.
  const seen = new Set<string>();
  const dedupedValid: typeof valid = [];
  let duplicates_in_input = 0;
  for (const v of valid) {
    if (seen.has(v.normalized)) {
      duplicates_in_input++;
    } else {
      seen.add(v.normalized);
      dedupedValid.push(v);
    }
  }

  // Chunked insert with onConflictDoNothing — duplicates against the existing
  // DB become silent no-ops. The returning array tells us exactly how many
  // rows were actually inserted (the conflicting ones are not returned).
  let inserted_count = 0;
  for (let i = 0; i < dedupedValid.length; i += CHUNK_SIZE) {
    const chunk = dedupedValid.slice(i, i + CHUNK_SIZE).map((v) => ({
      org_id: orgId,
      phone_number: v.normalized,
    }));
    const result = await db
      .insert(contacts)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: contacts.id });
    inserted_count += result.length;
  }

  const summary: UploadResultSummary = {
    submitted,
    valid: valid.length,
    invalid: invalid.length,
    duplicates_in_input,
    duplicates_in_db: dedupedValid.length - inserted_count,
    inserted: inserted_count,
    invalid_samples: invalid.slice(0, INVALID_SAMPLE_LIMIT),
  };

  return NextResponse.json(summary, { status: 201 });
}
