import { eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_stats, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

export async function POST(_req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Recompute all four counters for every segment in this org in a single
  // SQL statement. Single-statement upsert avoids per-segment round trips.
  // Uses a CTE that aggregates per-segment counts, then INSERTs into
  // segment_stats with ON CONFLICT to refresh existing rows.
  const result = await db.transaction(async (tx) => {
    const refreshed = await tx.execute(drizzleSql`
      WITH per_segment AS (
        SELECT
          s.id AS segment_id,
          s.org_id,
          (SELECT COUNT(*)::int FROM segment_contacts sc
            WHERE sc.segment_id = s.id) AS total_count,
          (SELECT COUNT(*)::int FROM segment_contacts sc
            WHERE sc.segment_id = s.id
              AND EXISTS (
                SELECT 1 FROM opt_outs oo
                WHERE oo.contact_id = sc.contact_id AND oo.org_id = ${orgId}
              )) AS opt_out_count,
          (SELECT COUNT(*)::int FROM segment_contacts sc
            WHERE sc.segment_id = s.id
              AND EXISTS (
                SELECT 1 FROM opt_ins oi
                WHERE oi.contact_id = sc.contact_id AND oi.org_id = ${orgId}
              )) AS opt_in_count,
          (SELECT COUNT(*)::int FROM segment_contacts sc
            WHERE sc.segment_id = s.id
              AND EXISTS (
                SELECT 1 FROM clickers c
                WHERE c.contact_id = sc.contact_id AND c.org_id = ${orgId}
              )) AS clicker_count
        FROM segments s
        WHERE s.org_id = ${orgId}
      )
      INSERT INTO segment_stats (segment_id, org_id, total_count, opt_out_count, opt_in_count, clicker_count, updated_at)
      SELECT segment_id, org_id, total_count, opt_out_count, opt_in_count, clicker_count, NOW()
        FROM per_segment
      ON CONFLICT (segment_id) DO UPDATE
        SET total_count = EXCLUDED.total_count,
            opt_out_count = EXCLUDED.opt_out_count,
            opt_in_count = EXCLUDED.opt_in_count,
            clicker_count = EXCLUDED.clicker_count,
            updated_at = NOW()
      RETURNING segment_id
    `);
    return refreshed;
  });

  // Drizzle's execute on postgres-js returns rows directly as an array.
  const refreshedCount = Array.isArray(result) ? result.length : 0;

  // Also report the number of segments in the org for the UI summary.
  const segCount = await db
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(segments)
    .where(eq(segments.org_id, orgId));

  return NextResponse.json({
    refreshed: refreshedCount,
    total_segments: segCount[0]?.count ?? 0,
  });
}
