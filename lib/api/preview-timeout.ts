import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError } from "@/lib/api/helpers";
import { isStatementTimeout } from "@/lib/db/statement-timeout";

// A campaign audience preview that hit its SET LOCAL statement_timeout is a
// 400 with a sentence the operator can act on, not a 500.
//
// ⚠️ THIS USED TO BE `(e as { code?: string })?.code === "57014"` IN THE ROUTE,
// and it never matched. Drizzle wraps the driver error ("Failed query: …") and
// the SQLSTATE sits on `err.cause`, so every timeout fell through to a 500 and
// the form said "Could not preview audience". Production 2026-09-30 19:14–19:22
// UTC: one operator, 9 previews, 5 timeouts, all five shown as 500 (card
// 869faaa3v). isStatementTimeout walks the cause chain.
//
// Returns null for anything that is not a statement timeout; the caller
// rethrows it unchanged.
export function previewTimeoutResponse(err: unknown) {
  if (!isStatementTimeout(err)) return null;
  return apiError(
    400,
    "Audience preview timed out — narrow the selection (fewer contact groups, or add a status filter) and try again.",
    API_ERROR_CODES.VALIDATION,
    { reason: "preview_timeout" },
  );
}
