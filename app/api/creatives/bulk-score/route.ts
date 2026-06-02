import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { scoreAndPersistCreative } from "@/lib/spam/score-creative";
import { creativeBulkScoreSchema } from "@/lib/validators/creatives";

// How many creatives we score concurrently within one request. The
// classifier service is the bottleneck; a small pool keeps us under the
// serverless timeout without hammering it. The validator caps the batch
// size, and the client chunks larger selections across requests.
const SCORE_CONCURRENCY = 5;

// Run `fn` over `items` with at most `limit` in flight at once.
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
}

// Spam-score a batch of creatives, mirroring each result onto its row.
// Already-scored creatives (non-null spam_score) are skipped unless
// `force` is set. Scoring potentially costs money, so it's gated on
// spam.score (operator+).
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "spam.score")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeBulkScoreSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;
  const uniqueIds = Array.from(new Set(input.creative_ids));

  const rows = await db
    .select({
      id: creatives.id,
      text: creatives.text,
      spam_score: creatives.spam_score,
    })
    .from(creatives)
    .where(and(eq(creatives.org_id, orgId), inArray(creatives.id, uniqueIds)));

  if (rows.length !== uniqueIds.length) {
    return apiError(
      400,
      "One or more creatives do not belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "creative_ids" },
    );
  }

  // Skip-already-scored: a row counts as scored once it has a numeric
  // spam_score. Rows that previously errored (score still NULL) get
  // retried. `force` re-scores everything.
  const toScore = input.force
    ? rows
    : rows.filter((r) => r.spam_score === null);
  const skipped = rows.length - toScore.length;

  let scored = 0;
  let failed = 0;
  await runPool(toScore, SCORE_CONCURRENCY, async (r) => {
    const result = await scoreAndPersistCreative({
      creativeId: r.id,
      orgId,
      text: r.text,
    });
    if (result.spam_score_error) failed++;
    else scored++;
  });

  return NextResponse.json({ scored, skipped, failed });
}
