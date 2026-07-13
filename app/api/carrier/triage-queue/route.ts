import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { db } from "@/db/client";
import { can } from "@/lib/permissions";
import { contactCountsByMatchKey } from "@/lib/carrier/queue-stats";

export interface TriageQueueRow {
  match_key: string;
  raw_example: string;
  status: string;
  confidence: number | null;
  last_error: string | null;
  contact_count: number;
}

// The carrier-triage review queue: distinct unresolved strings awaiting (or having
// failed) AI triage, ranked by how many contacts each affects. Permission: manager+.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const [rows, counts] = await Promise.all([
    db.execute<{
      match_key: string;
      raw_example: string;
      status: string;
      confidence: number | null;
      last_error: string | null;
    }>(sql`
      SELECT match_key, raw_example, status, confidence, last_error
      FROM carrier_classify_queue
      WHERE status IN ('pending', 'needs_human')`),
    contactCountsByMatchKey(),
  ]);

  const data: TriageQueueRow[] = rows
    .map((r) => ({
      match_key: r.match_key,
      raw_example: r.raw_example,
      status: r.status,
      confidence: r.confidence === null ? null : Number(r.confidence),
      last_error: r.last_error,
      contact_count: counts.get(r.match_key) ?? 0,
    }))
    .sort((a, b) => b.contact_count - a.contact_count);

  return NextResponse.json({ data });
}
