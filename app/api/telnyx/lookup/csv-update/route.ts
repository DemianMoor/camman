import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { importCsvLookups } from "@/lib/telnyx/csv-import";

export const maxDuration = 60;

const schema = z.object({
  rows: z
    .array(
      z.object({
        phone: z.string().min(1),
        line_type: z.string().nullable().optional(),
        carrier: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(100_000),
});

// Bulk-update carrier data for EXISTING contacts from an external CSV (phone +
// line_type + carrier). Writes phone_lookups (source='csv_import', never overwriting
// a telnyx row) + syncs contacts. Makes NO Telnyx calls. Permission: manager+.
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  return NextResponse.json(await importCsvLookups(parsed.data.rows));
}
