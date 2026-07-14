import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewMatchList } from "@/lib/telnyx/preview";

export const maxDuration = 60;

// Cap the paste so a pathological input can't build an unbounded work set. The
// client parses CSV/textarea to newline-joined lines; well beyond any real list.
const MAX_LINES = 200_000;
const schema = z.object({ phones: z.string().min(1) });

// Read-only preview for "Upload a list to look up (existing numbers only)": match
// the pasted list against existing contacts and break it into matched / not-found /
// already-looked-up / to-enqueue + cost + balance + cap ETA. Creates nothing.
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
  return NextResponse.json(await previewMatchList(auth.orgId, lines));
}
