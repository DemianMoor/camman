import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { enqueueNormalized } from "@/lib/telnyx/enqueue";
import { matchExistingContacts } from "@/lib/telnyx/match-list";

export const maxDuration = 60;

const MAX_LINES = 200_000;
const schema = z.object({ phones: z.string().min(1) });

// Enqueue lookups for a pasted list, matching ONLY numbers that already exist as
// org contacts — not-found numbers are reported and NEVER created. Re-matches
// server-side (never trusts a client match set), then enqueues the matched set via
// the existing enqueue path (dedup vs cache-complete + already-pending). The
// existing worker drains it under the existing daily cap / lease / balance gate.
// Permission: manager+ (lookup.admin).
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
  const lines = parsed.data.phones.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) {
    return apiError(400, `Too many numbers (max ${MAX_LINES.toLocaleString()})`, API_ERROR_CODES.VALIDATION);
  }

  const m = await matchExistingContacts(auth.orgId, lines);
  // Enqueue ONLY the matched, existing contacts. enqueueNormalized dedups against
  // cache-complete + already-pending, so `enqueued` == the to-enqueue set.
  const result = await enqueueNormalized(auth.orgId, m.matchedPhones, "upload");

  return NextResponse.json({
    ...result,
    matched: m.matched,
    not_found: m.not_found,
    already_looked_up: m.already_looked_up,
    already_queued: m.already_queued,
  });
}
