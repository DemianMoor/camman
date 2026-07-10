import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  assignCarrierMapping,
  ASSIGNABLE_BUCKETS,
  type CarrierBucket,
} from "@/lib/telnyx/assign-mapping";

const schema = z.object({
  raw_name: z.string().min(1),
  bucket: z.enum(ASSIGNABLE_BUCKETS as readonly [string, ...string[]]),
});

// Assign a raw carrier string to a bucket, retroactively reclassifying every
// 'Unmapped' phone_lookups row + contact for that string. Permission: manager+.
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
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const result = await assignCarrierMapping(
    parsed.data.raw_name,
    parsed.data.bucket as CarrierBucket,
  );
  return NextResponse.json(result);
}
