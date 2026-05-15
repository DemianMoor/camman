import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_contacts, segment_stats, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewSegmentAudienceCount } from "@/lib/segment-rules-eval";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Preview the rule-filtered count for one segment. Hard 10s timeout via
// SET LOCAL statement_timeout inside a transaction. Returns the manual
// membership count alongside so the UI can show "{N} of {M}" framing.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION);
  }
  const segR = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segR[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  // Manual membership count — cheap, always returnable. Doesn't need the
  // rules clause, but should respect the same statement_timeout to be
  // defensive against very large segments.
  const [manualRow] = await db
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(segment_contacts)
    .where(
      and(
        eq(segment_contacts.segment_id, segmentId),
        eq(segment_contacts.org_id, orgId),
      ),
    );
  const manualCount = manualRow?.count ?? 0;

  const result = await previewSegmentAudienceCount(segmentId, orgId);

  if (result.truncated) {
    return NextResponse.json({
      count: null,
      manual_count: manualCount,
      rule_filtered_count: null,
      duration_ms: result.durationMs,
      truncated: true,
    });
  }

  // Persist the freshly computed count to segment_stats so the segments
  // list + detail header show the rule-matched audience without a manual
  // /refresh-stats round trip. Fire-and-forget — failures here don't
  // affect the preview response. The org_id filter on the segment_stats
  // row matches the existing one in /refresh-stats.
  try {
    await db
      .update(segment_stats)
      .set({
        rule_filtered_count: result.count,
        updated_at: drizzleSql`now()`,
      })
      .where(
        and(
          eq(segment_stats.segment_id, segmentId),
          eq(segment_stats.org_id, orgId),
        ),
      );
  } catch {
    // Swallow — caching is best-effort.
  }

  return NextResponse.json({
    count: result.count,
    manual_count: manualCount,
    rule_filtered_count: result.count,
    duration_ms: result.durationMs,
    truncated: false,
  });
}
