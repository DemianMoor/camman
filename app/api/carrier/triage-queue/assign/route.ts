import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { resolveQueueByHuman } from "@/lib/carrier/apply-mapping";
import { ASSIGNABLE_BUCKETS, type CarrierBucket } from "@/lib/telnyx/assign-mapping";

const schema = z.object({
  match_key: z.string().min(1),
  raw_example: z.string().min(1),
  bucket: z.enum(ASSIGNABLE_BUCKETS as readonly [string, ...string[]]),
});

// Assign a triage-queue string to a bucket. Writes the mapping on the NORMALIZED
// key (retro-updating every route-suffix variant + affected contacts) and marks the
// queue row human_resolved. Permission: manager+.
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

  const result = await resolveQueueByHuman(
    parsed.data.match_key,
    parsed.data.raw_example,
    parsed.data.bucket as CarrierBucket,
  );
  return NextResponse.json(result);
}
