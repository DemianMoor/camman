import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  type AttemptClassification,
  classificationOwner,
} from "@/lib/sends/classify-attempt";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Aggregated send-attempt evidence for a stage (Workstream 3, UI layer). Built
// from the LATEST attempt per stage_send (a row may have several attempts via
// retry; its current outcome is the most recent one). Powers the failure banner
// (mine/theirs/indeterminate split) and the grouped-error drill-down.
export interface StageAttemptSummary {
  // Latest-attempt classification counts across the stage.
  accepted: number;
  mine_transport: number;
  theirs_rejected: number;
  indeterminate: number;
  // Owner rollup for the banner headline.
  owners: { us: number; texthub: number; manual: number };
  // Grouped failures for the drill-down: "9× no_credential", etc. Accepted rows
  // are excluded — this is the failure view.
  groups: { classification: AttemptClassification; error: string | null; count: number }[];
  total_failed: number; // non-accepted latest attempts
}

const EMPTY: StageAttemptSummary = {
  accepted: 0,
  mine_transport: 0,
  theirs_rejected: 0,
  indeterminate: 0,
  owners: { us: 0, texthub: 0, manual: 0 },
  groups: [],
  total_failed: 0,
};

function isClassification(v: string): v is AttemptClassification {
  return (
    v === "accepted" ||
    v === "mine_transport" ||
    v === "theirs_rejected" ||
    v === "indeterminate"
  );
}

export async function summarizeStageAttempts(
  dbc: DbOrTx,
  opts: { stageId: number; orgId: string },
): Promise<StageAttemptSummary> {
  const rows = (await dbc.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (sa.stage_send_id)
        sa.stage_send_id, sa.classification, sa.error
      FROM send_attempts sa
      JOIN stage_sends ss ON ss.id = sa.stage_send_id
      WHERE ss.stage_id = ${opts.stageId} AND ss.org_id = ${opts.orgId}::uuid
      ORDER BY sa.stage_send_id, sa.id DESC
    )
    SELECT classification, error, count(*)::int AS n
    FROM latest
    GROUP BY classification, error
    ORDER BY n DESC
  `)) as unknown as { classification: string; error: string | null; n: number }[];

  if (!rows.length) return { ...EMPTY };

  const out: StageAttemptSummary = {
    ...EMPTY,
    owners: { us: 0, texthub: 0, manual: 0 },
    groups: [],
  };

  for (const r of rows) {
    if (!isClassification(r.classification)) continue;
    const n = Number(r.n);
    out[r.classification] += n;
    const owner = classificationOwner(r.classification);
    if (owner === "us") out.owners.us += n;
    else if (owner === "texthub") out.owners.texthub += n;
    else if (owner === "manual") out.owners.manual += n;
    if (r.classification !== "accepted") {
      out.total_failed += n;
      out.groups.push({ classification: r.classification, error: r.error, count: n });
    }
  }

  return out;
}
