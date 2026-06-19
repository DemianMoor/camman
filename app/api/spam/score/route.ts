import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { consume } from "@/lib/api/rate-limit";
import { can } from "@/lib/permissions";
import { scoreMessage } from "@/lib/spam";

// A cold classifier can need up to MAX_ATTEMPTS × per-attempt timeout
// (~50s) to warm + answer. Give the function room so the platform doesn't
// kill it mid-retry at the default (~10–15s) ceiling.
export const maxDuration = 60;

const TEXT_MAX = 1600;

const bodySchema = z.object({
  text: z
    .string()
    .min(1, "text is required")
    .max(TEXT_MAX, `text must be at most ${TEXT_MAX} characters`),
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "spam.score")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // 60 req/min per user. The token bucket grants 1 req/sec on average with
  // a burst of 60 — operator-friendly for the debug page, hostile to abuse.
  const rl = consume({
    key: `spam.score:${user.id}`,
    capacity: 60,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return apiError(
      429,
      "Rate limit exceeded — too many scoring requests",
      API_ERROR_CODES.RATE_LIMITED,
      { retryAfterMs: rl.retryAfterMs },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const result = await scoreMessage(orgId, parsed.data.text, {
      force: parsed.data.force,
      userId: user.id,
    });
    return NextResponse.json({
      score: result.score,
      label: result.label,
      verdict: result.verdict,
      confidence: result.confidence,
      cached: result.cached,
      provider: result.provider,
      modelVersion: result.modelVersion,
      latencyMs: result.latencyMs,
      textHash: result.textHash,
      error: result.error,
    });
  } catch (err) {
    // The classifier provider already swallows fetch errors into the
    // result's `error` field — anything that escapes here is an
    // unexpected programming error or a DB issue.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("classifier")) {
      return apiError(
        502,
        msg,
        API_ERROR_CODES.INTERNAL,
        { reason: "classifier_unreachable" },
      );
    }
    return apiError(500, msg, API_ERROR_CODES.INTERNAL);
  }
}
