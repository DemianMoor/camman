import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Lightweight read-only materialization progress for the Prepare UI: how many
// stage_sends rows exist for this stage yet, and whether materialization is
// complete (campaign_stages.materialized_at set). The Prepare dialog polls this
// while the (long) approve-send call runs so the operator sees a live count
// instead of a frozen button. Read-only — never triggers materialization.
function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam, stageId: sIdParam } = await params;
  const campaignId = parseId(cIdParam);
  const stageId = parseId(sIdParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Exclude 'rejected' — rows cancelled by a previous …/send/abort, kept for
  // audit. Re-preparing an aborted stage leaves them in place, so an unfiltered
  // count reported the PRIOR run's residue as progress for the current one:
  // stage 1710 read 8,843 against 4,445 real recipients (~2x) and the bar started
  // near-full before a single new row existed. 'rejected' is written ONLY by the
  // abort path, so it is unambiguously prior-run.
  //
  // 'skipped_opted_out' is deliberately NOT excluded: those rows are legitimately
  // created BY the run in progress (recipients suppressed at materialization
  // time, migration 0116) and counting them keeps the bar tracking real progress
  // against the preflight target. The only residue that survives here is any
  // skipped_opted_out row from the earlier run — 2 rows on stage 1710, 10 on
  // 1713 — which is a rounding error next to the 4,396/9,179 this filter removes.
  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM stage_sends ss
        WHERE ss.stage_id = ${stageId} AND ss.org_id = ${orgId}
          AND ss.status <> 'rejected') AS materialized,
      (s.materialized_at IS NOT NULL) AS complete
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as { materialized: number; complete: boolean }[];

  if (!rows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }

  return NextResponse.json({
    materialized: Number(rows[0].materialized),
    complete: rows[0].complete === true,
  });
}
