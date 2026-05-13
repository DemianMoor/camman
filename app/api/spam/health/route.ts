import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const DEFAULT_TIMEOUT_MS = 5_000;

// Lightweight health check against the classifier service. Used by the
// debug page's status indicator. The classifier's /health endpoint is
// open (no API key required) — that's by design on the classifier side.
// Operator-gated here so we don't reveal internal infra to viewers.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { role } = auth;

  if (!can(role, "spam.score")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const url = process.env.CLASSIFIER_URL;
  if (!url) {
    return NextResponse.json({
      status: "error",
      latencyMs: 0,
      error: "CLASSIFIER_URL not set",
    });
  }

  const start = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return NextResponse.json({
        status: "error",
        latencyMs,
        error: `health returned ${res.status}`,
      });
    }
    const body = (await res.json().catch(() => ({}))) as {
      model_id?: string;
      model_version?: string;
      status?: string;
    };
    return NextResponse.json({
      status: "ok",
      latencyMs,
      modelId: body.model_id,
      modelVersion: body.model_version,
    });
  } catch (err) {
    return NextResponse.json({
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
