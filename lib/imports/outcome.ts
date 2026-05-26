import type { StatusValueMap } from "./canonical-fields";

export type RowOutcome =
  | "delivered"
  | "failed"
  | "optout"
  | "clicker"
  | "scrubbed"
  | "bounced"
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
  is_scrubbed: boolean;
  is_bounced: boolean;
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
  "filtered",
]);
const HEURISTIC_OPT_OUT = new Set([
  // Boolean-ish (matches the legacy is_optout column too)
  "true",
  "1",
  "yes",
  // STOP-style — single and plural, present and past tense
  "stop",
  "stops",
  "stopped",
  "stopping",
  // Unsubscribe family
  "unsub",
  "unsubs",
  "unsubscribe",
  "unsubscribes",
  "unsubscribed",
  "unsubscribing",
  // Opt-out family (space / hyphen / underscore / no-separator + plurals)
  "optout",
  "optouts",
  "opt-out",
  "opt-outs",
  "opt_out",
  "opt_outs",
  "opt out",
  "opt outs",
  // Removed / blocked are also occasionally used by providers
  "removed",
  "blocked",
]);
const HEURISTIC_CLICKED = new Set([
  // Boolean-ish (matches the legacy is_clicker column too)
  "true",
  "1",
  "yes",
  // Click family — singular, plural, present, past
  "click",
  "clicks",
  "clicked",
  "clicking",
  "clicker",
  "clickers",
  // Click-through variants
  "clickthrough",
  "click-through",
  "click_through",
  "click through",
  "clickthroughs",
  "click-throughs",
  "click_throughs",
  "click throughs",
  // Engagement aliases
  "engaged",
  "engagement",
]);
// Scrubbed = provider rejected the number as non-mobile (landline, invalid,
// not_mobile, etc.). Universal exclusion (no brand junction created).
const HEURISTIC_SCRUBBED = new Set([
  "scrubbed",
  "scrub",
  "invalid",
  "not_mobile",
  "not-mobile",
  "landline",
]);
// Bounced = carrier rejected the actual delivery. Universal exclusion.
const HEURISTIC_BOUNCED = new Set(["bounced", "bounce"]);

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
// Priority order:
//   1. opt-out   — explicit is_optout column truthy OR status_raw matches
//                  opt_out values. Recipient said STOP.
//   2. scrubbed  — provider rejected the number as non-mobile. Universal
//                  exclusion bucket; propagated into opt_outs with
//                  reason='scrubbed'.
//   3. bounced   — carrier rejected the delivery. Universal exclusion
//                  bucket; propagated into opt_outs with reason='bounced'.
//   4. clicker   — explicit is_clicker column truthy OR status_raw matches
//                  clicker values. Can co-occur with delivered; we set
//                  both flags but the outcome bucket is "clicker" because
//                  that drives downstream propagation into the clickers
//                  table.
//   5. delivered — status_raw matches delivered values
//   6. failed    — status_raw matches failed values (includes "filtered")
//   7. noop      — none of the above; recorded as audit but no counter.
//
// Opt-out wins over everything because the explicit is_optout column is
// the most reliable signal. Scrubbed and bounced go BEFORE clicker /
// delivered / failed because a number can't simultaneously be "delivered
// but also scrubbed" — if the provider says "scrubbed" the message did
// not go out, period.
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
    is_scrubbed: false,
    is_bounced: false,
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

  // 2. Scrubbed — provider didn't recognize the number as mobile.
  if (
    statusMatches(row.status_raw, statusValueMap?.scrubbed, HEURISTIC_SCRUBBED)
  ) {
    result.outcome = "scrubbed";
    result.is_scrubbed = true;
    return result;
  }

  // 3. Bounced — carrier rejected delivery.
  if (
    statusMatches(row.status_raw, statusValueMap?.bounced, HEURISTIC_BOUNCED)
  ) {
    result.outcome = "bounced";
    result.is_bounced = true;
    return result;
  }

  // 4. Clicker — explicit is_clicker column OR status word matches.
  // Can co-occur with delivered (a row that says status='delivered' and
  // is_clicker=true is BOTH); we classify the bucket as "clicker" because
  // that drives downstream propagation, but the is_delivered flag is
  // also set when the status agrees.
  if (
    isTruthy(row.is_clicker_raw) ||
    statusMatches(row.status_raw, statusValueMap?.clicker, HEURISTIC_CLICKED)
  ) {
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

  // 5. Delivered
  if (
    statusMatches(row.status_raw, statusValueMap?.delivered, HEURISTIC_DELIVERED)
  ) {
    result.outcome = "delivered";
    result.is_delivered = true;
    return result;
  }

  // 6. Failed
  if (statusMatches(row.status_raw, statusValueMap?.failed, HEURISTIC_FAILED)) {
    result.outcome = "failed";
    result.is_failed = true;
    return result;
  }

  // 7. No recognizable outcome.
  return result;
}

// Re-export the heuristic clicked set so the UI can use it for the
// status-value-mapping suggestion preview.
export const CLICKED_HEURISTIC = HEURISTIC_CLICKED;

// Priority for collapsing duplicate phone numbers within a single CSV
// import. When the same number appears multiple times — typically one
// row per provider event (sent → delivered → clicked → STOP) — the row
// with the HIGHEST priority outcome wins. The losing rows are dropped
// (their cost / raw_row data is lost; only the winner is stored in
// stage_result_rows).
//
// Order — highest priority first:
//   7. optout    — recipient said STOP, strongest signal
//   6. scrubbed  — provider rejected the number as non-mobile
//   5. bounced   — carrier rejected delivery
//   4. clicker   — recipient engagement
//   3. delivered — passive delivery success
//   2. failed    — delivery failure (potentially transient)
//   1. noop      — no signal
//
// Rationale: opt-out trumps everything because it's the user's explicit
// instruction and overrides any prior engagement / delivery. Exclusion
// signals (scrubbed/bounced) trump engagement and success because they
// indicate the number can't reach the recipient going forward.
// Engagement (clicker) trumps passive delivery. Delivered trumps failed
// because positive confirmation outweighs a transient failure.
export const OUTCOME_PRIORITY: Record<RowOutcome, number> = {
  optout: 7,
  scrubbed: 6,
  bounced: 5,
  clicker: 4,
  delivered: 3,
  failed: 2,
  noop: 1,
};
