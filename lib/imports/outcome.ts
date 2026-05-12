import type { StatusValueMap } from "./canonical-fields";

export type RowOutcome =
  | "delivered"
  | "failed"
  | "optout"
  | "clicker"
  | "noop";

export interface ParsedRow {
  phone_number: string | null; // E.164-normalized; null if invalid
  status_raw: string | null;
  is_optout_raw: string | null;
  is_clicker_raw: string | null;
  cost: number | null;
  raw: Record<string, string>; // entire CSV row for audit
}

export interface OutcomeResult {
  outcome: RowOutcome;
  is_delivered: boolean;
  is_failed: boolean;
  is_optout: boolean;
  is_clicker: boolean;
}

// Truthy-string set used for explicit boolean-like columns. Anything else
// (incl. empty / null) is falsy.
const TRUTHY = new Set(["1", "true", "yes", "y", "t"]);

// Heuristic word lists for the no-statusValueMap fallback path. These match
// what the spec lays out; keep in sync if you extend them.
const HEURISTIC_DELIVERED = new Set([
  "delivered",
  "ok",
  "sent",
  "success",
  "true",
  "1",
  "yes",
]);
const HEURISTIC_FAILED = new Set([
  "failed",
  "error",
  "rejected",
  "undelivered",
]);
const HEURISTIC_OPT_OUT = new Set([
  "stop",
  "unsubscribe",
  "unsub",
  "optout",
  "opt-out",
  "true",
  "1",
  "yes",
]);
const HEURISTIC_CLICKED = new Set(["clicked", "true", "1", "yes"]);

function isTruthy(v: string | null): boolean {
  if (v == null) return false;
  return TRUTHY.has(v.trim().toLowerCase());
}

function statusMatches(
  raw: string | null,
  explicit: string[] | undefined,
  heuristic: ReadonlySet<string>,
): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return false;
  if (explicit && explicit.length > 0) {
    return explicit.some((s) => s.trim().toLowerCase() === v);
  }
  return heuristic.has(v);
}

// Derive the outcome for a single parsed CSV row.
//
// Priority (matches spec):
//   1. opt-out  — explicit is_optout column truthy OR status_raw matches
//                 opt_out values
//   2. clicker  — is_clicker_raw truthy. Note: a row can be BOTH a clicker
//                 AND delivered; we set both flags but the outcome bucket
//                 is "clicker" because that drives downstream propagation
//                 into the clickers table.
//   3. delivered — status_raw matches delivered values
//   4. failed    — status_raw matches failed values
//   5. noop      — none of the above; recorded as audit but no counter.
//
// Pass statusValueMap when the user has configured explicit per-provider
// status words. Without it, the heuristic word lists are used.
export function deriveOutcome(
  row: ParsedRow,
  statusValueMap?: StatusValueMap,
): OutcomeResult {
  const result: OutcomeResult = {
    outcome: "noop",
    is_delivered: false,
    is_failed: false,
    is_optout: false,
    is_clicker: false,
  };

  // 1. Opt-out wins over everything.
  if (
    isTruthy(row.is_optout_raw) ||
    statusMatches(row.status_raw, statusValueMap?.opt_out, HEURISTIC_OPT_OUT)
  ) {
    result.outcome = "optout";
    result.is_optout = true;
    return result;
  }

  // 2. Clicker — can co-occur with delivered. We still classify the row
  // as "clicker" in the outcome bucket, but the is_delivered flag will be
  // set too if the status says so.
  if (isTruthy(row.is_clicker_raw)) {
    result.outcome = "clicker";
    result.is_clicker = true;
    if (
      statusMatches(
        row.status_raw,
        statusValueMap?.delivered,
        HEURISTIC_DELIVERED,
      )
    ) {
      result.is_delivered = true;
    }
    return result;
  }

  // 3. Delivered
  if (
    statusMatches(row.status_raw, statusValueMap?.delivered, HEURISTIC_DELIVERED)
  ) {
    result.outcome = "delivered";
    result.is_delivered = true;
    return result;
  }

  // 4. Failed
  if (statusMatches(row.status_raw, statusValueMap?.failed, HEURISTIC_FAILED)) {
    result.outcome = "failed";
    result.is_failed = true;
    return result;
  }

  // 5. No recognizable outcome.
  return result;
}

// Re-export the heuristic clicked set so the UI can use it for the
// status-value-mapping suggestion preview.
export const CLICKED_HEURISTIC = HEURISTIC_CLICKED;
