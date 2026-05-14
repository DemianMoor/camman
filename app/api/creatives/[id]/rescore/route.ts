import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { scoreAndPersistCreative } from "@/lib/spam/score-creative";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Manually re-score a single creative. Useful after a transient classifier
// failure (spam_score_error populated, score/label NULL). The actual
// scoring still goes through the shared cache — if the text hasn't
// changed and the cache has a result, this is a cache hit.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({ id: creatives.id, text: creatives.text, status: creatives.status })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!rows[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  if (rows[0].status === "archived") {
    return apiError(
      409,
      "Archived creatives can't be re-scored — restore first",
      API_ERROR_CODES.CONFLICT,
      { reason: "archived" },
    );
  }

  const result = await scoreAndPersistCreative({
    creativeId,
    orgId,
    text: rows[0].text,
  });
  return NextResponse.json(result);
}
