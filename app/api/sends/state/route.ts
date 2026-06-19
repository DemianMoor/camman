import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getSendState } from "@/lib/sends/send-state";

// WS4 Group B shared read endpoint — the operating layer's "send state" snapshot.
// Feeds the app-level send-state strip (B3), the volume-vs-caps meter (B4), and
// the stuck-row callout (B6) from ONE query set. Read-only; any member can read
// (same bar as GET /api/settings/sending). Never emits provider credentials.
// The query set itself lives in lib/sends/send-state.ts so the protected layout
// can server-render the same snapshot into <SendStateStrip> without a client
// round-trip. Response shape is unchanged.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  return NextResponse.json(await getSendState(orgId));
}
