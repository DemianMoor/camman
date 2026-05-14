import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  clickers,
  opt_ins,
  opt_outs,
  segment_contacts,
  segment_rules,
  segment_stats,
  segments,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewSegmentAudienceCount } from "@/lib/segment-rules-eval";

// TODO: rule_filtered_count computation can get expensive at scale —
// it runs the full rule clause against segment_contacts. Consider
// materializing audience snapshots if refresh latency exceeds 5s per
// segment, or moving this work to a background job.

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const segRow = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segRow[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  // Compute the three engagement counters via EXISTS subqueries so each
  // contact in the segment is matched at most once per source table.
  //
  // Use literal table-qualified SQL identifiers inside the FILTER clause:
  // Drizzle's ${column} interpolation can collapse to a bare column name
  // when nested inside a raw template fragment, which lets PostgreSQL
  // resolve `contact_id = contact_id` to the inner-scope column (always
  // true → every row counted). Literal qualification disambiguates.
  const [counts] = await db
    .select({
      total_count: drizzleSql<number>`count(*)::int`,
      opt_out_count: drizzleSql<number>`count(*) filter (
        where exists (
          select 1 from "opt_outs"
          where "opt_outs"."contact_id" = "segment_contacts"."contact_id"
            and "opt_outs"."org_id" = ${orgId}
        )
      )::int`,
      opt_in_count: drizzleSql<number>`count(*) filter (
        where exists (
          select 1 from "opt_ins"
          where "opt_ins"."contact_id" = "segment_contacts"."contact_id"
            and "opt_ins"."org_id" = ${orgId}
        )
      )::int`,
      clicker_count: drizzleSql<number>`count(*) filter (
        where exists (
          select 1 from "clickers"
          where "clickers"."contact_id" = "segment_contacts"."contact_id"
            and "clickers"."org_id" = ${orgId}
        )
      )::int`,
    })
    .from(segment_contacts)
    .where(
      and(
        eq(segment_contacts.segment_id, segmentId),
        eq(segment_contacts.org_id, orgId),
      ),
    );

  // Compute rule_filtered_count only when the segment has at least one
  // active rule. Without rules, rule-filtered === manual (total_count),
  // and we leave the column null to signal "no rule filtering needed."
  const activeRules = await db
    .select({ id: segment_rules.id })
    .from(segment_rules)
    .where(
      and(
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
        eq(segment_rules.is_active, true),
      ),
    )
    .limit(1);

  let ruleFilteredCount: number | null = null;
  if (activeRules.length > 0) {
    const r = await previewSegmentAudienceCount(segmentId, orgId);
    // On timeout (truncated), leave null so the UI can show "—" rather
    // than persist a misleading stale value.
    ruleFilteredCount = r.truncated ? null : r.count;
  }

  const updated = await db
    .insert(segment_stats)
    .values({
      segment_id: segmentId,
      org_id: orgId,
      total_count: counts.total_count,
      opt_out_count: counts.opt_out_count,
      opt_in_count: counts.opt_in_count,
      clicker_count: counts.clicker_count,
      rule_filtered_count: ruleFilteredCount,
    })
    .onConflictDoUpdate({
      target: segment_stats.segment_id,
      set: {
        total_count: counts.total_count,
        opt_out_count: counts.opt_out_count,
        opt_in_count: counts.opt_in_count,
        clicker_count: counts.clicker_count,
        rule_filtered_count: ruleFilteredCount,
        updated_at: drizzleSql`now()`,
      },
    })
    .returning();

  return NextResponse.json(updated[0]);
}
