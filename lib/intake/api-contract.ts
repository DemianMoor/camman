import { RETRY_DELAYS_MS } from "@/lib/partners/postbacks/constants";

import { LEAD_FIELDS, MAX_LEADS_PER_CALL } from "./fields";
import { PASSTHROUGH_LIMITS, SYSTEM_PLACEHOLDERS } from "./passthrough";

// The partner-facing API contract — the parts that are NOT the field list.
//
// ⭐ ONE SOURCE, TWO RENDERERS. `lib/intake/fields.ts` is already the single
// source for what the endpoint accepts; this module is the single source for
// everything ELSE a partner needs (status codes, examples, limits, changelog),
// so the public page at /docs/partner-api and the generated markdown at
// docs/partners/lead-intake.md cannot tell a partner two different things.
//
// ⚠️ THE EXAMPLES ARE DERIVED FROM LEAD_FIELDS, NOT TYPED OUT. That is what
// makes "a field added to intake appears in the docs without a separate edit"
// true of the example request too, and not just of the field table. A
// hand-written example is the first thing to rot: it keeps showing the payload
// that was correct a year ago.
//
// ⚠️ NOTHING INTERNAL BELONGS IN HERE. No table names, no provider names, no
// infrastructure, no per-partner values, no secrets. Everything in this module
// is published to anyone with the URL. Per-key numbers (rate limits, payload
// caps) are deliberately described in words, not printed — they differ per
// partner and are given to each partner directly.

export const ENDPOINT_PATH = "/api/intake/leads/<YOUR_TOKEN>";
export const ENDPOINT_METHOD = "POST";

/** Header a partner may use instead of `Authorization: Bearer`. */
export const ALT_SECRET_HEADER = "X-Partner-Secret";

export interface ResponseCode {
  status: number;
  meaning: string;
  /** Resolution — what the partner does about it. The point of the table. */
  action: string;
  /** Whether retrying the identical request can succeed. */
  retry: "yes" | "no" | "after-delay";
}

/**
 * Every status the endpoint can return.
 *
 * ⚠️ Kept in the same order the route can emit them, and asserted against the
 * route's source by scripts/test-partner-docs-drift.ts — a status added to the
 * handler without a row here fails the check.
 */
export const RESPONSE_CODES: ResponseCode[] = [
  {
    status: 202,
    meaning: "Request accepted. The body reports per-lead outcomes.",
    action: "None. Reconcile against the `leads` array by index.",
    retry: "no",
  },
  {
    status: 400,
    meaning: "The body is not valid JSON, or contains no leads.",
    action: "Correct the request before resending.",
    retry: "no",
  },
  {
    status: 401,
    meaning: "The token or secret is invalid.",
    action:
      "Verify both credentials. Repeated failures on a valid token are alerted internally.",
    retry: "no",
  },
  {
    status: 403,
    meaning: "The key is recognised but disabled.",
    action: "Contact your account manager.",
    retry: "no",
  },
  {
    status: 413,
    meaning:
      "The payload exceeds the size limit, the batch exceeds the per-call lead limit, " +
      "or the batch exceeds the daily allowance. The applicable limit is named in the body.",
    action:
      "Split into smaller batches and resend. No leads were stored. Exception: if the body " +
      "names `rate_per_day`, the batch is larger than your whole daily allowance and cannot " +
      "succeed until that limit is raised — contact us instead of retrying.",
    retry: "yes",
  },
  {
    status: 429,
    meaning: "A rate limit was exceeded. No leads were stored.",
    action:
      "Wait the interval given in `Retry-After`, then resend the full batch. " +
      "Allowance is not consumed. For the DAILY limit (`\"window\": \"day\"`) `Retry-After` " +
      "runs to midnight US Eastern: today's allowance is used up, so this is final for today — " +
      "resend tomorrow, not later today.",
    retry: "after-delay",
  },
  {
    status: 500,
    meaning: "The request could not be stored.",
    action: "Resend. Duplicate detection is idempotent, so retries are safe.",
    retry: "yes",
  },
];

/** One realistic lead, built from every field's own documented example. */
export function exampleLead(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LEAD_FIELDS) out[f.key] = f.example;
  return out;
}

/** The minimal accepted payload — the required fields and nothing else. */
export function minimalLead(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LEAD_FIELDS.filter((f) => f.required)) out[f.key] = f.example;
  return out;
}

/**
 * A batch example: one full lead, one minimal, one with a different phone — so
 * a partner can see that heterogeneous rows in a single call are fine.
 */
export function exampleBatch(): Record<string, string>[] {
  const full = exampleLead();
  const second: Record<string, string> = { ...minimalLead(), phone: "+12025550111" };
  const firstName = LEAD_FIELDS.find((f) => f.key === "first_name");
  if (firstName) second[firstName.key] = "John";
  return [full, second];
}

/** The 202 body shape, with the counts a two-lead batch would produce. */
export const EXAMPLE_202_RESPONSE = {
  accepted: 2,
  duplicates: 0,
  rejected: 0,
  sandbox: true,
  leads: [
    { id: "3f1c…", status: "received", duplicate: false },
    { id: "9ab4…", status: "received", duplicate: false },
  ],
};

/**
 * Appended to the 202 example on both docs. The example's keys are unchanged
 * (existing integrations parse that shape); `warnings` is additive and present
 * on a lead entry only when something in that lead was dropped.
 */
export const WARNINGS_NOTE =
  "A lead entry may also carry a `warnings` array of strings. It appears only when " +
  "part of that lead was dropped (for example a passthrough field whose value was too " +
  "long); the lead itself is still accepted.";

/** Human label for a retry delay; shared by both renderers. */
export function formatDelay(ms: number): string {
  return ms < 3_600_000 ? `${ms / 60_000} min` : `${ms / 3_600_000} h`;
}

/**
 * Generic passthrough-field mechanism. The field NAMES are agreed per partner
 * and are NOT listed here (they are shared with each partner directly).
 */
export const PASSTHROUGH_DOC = {
  title: "Passthrough fields",
  intro:
    "Besides the fields above, we can agree a short list of extra field names with you. " +
    "Values you send in those fields are stored with the lead and handed back to you in " +
    "sales postbacks (see below). The agreed names are given to you directly.",
  rules: [
    "Field names are matched case-insensitively.",
    "Unknown fields are ignored: only the standard fields above and your agreed names are used.",
    `Up to ${PASSTHROUGH_LIMITS.maxFields} agreed fields; each name is at most ${PASSTHROUGH_LIMITS.maxNameLength} characters (lowercase letters, digits and underscore, starting with a letter).`,
    `Each value is at most ${PASSTHROUGH_LIMITS.maxValueLength} characters, and all passthrough values together are at most ${PASSTHROUGH_LIMITS.maxTotalBytes} bytes.`,
    "A field with a value that does not fit the limits is dropped and the lead is still accepted; the lead's entry in the 202 response then carries a `warnings` array.",
  ],
  example: { phone: "+12025550199", your_field: "abc-123", another_field: "xyz" },
};

const PLACEHOLDER_MEANING: Record<(typeof SYSTEM_PLACEHOLDERS)[number], string> = {
  status: "Outcome of the sale, for example approved.",
  event: "Event type of the sale.",
  conversion_id: "Unique id of this sale. Use it to de-duplicate.",
  occurred_at: "When the sale happened, UTC, ISO 8601.",
  currency: "Currency code of the amount.",
  payout: "Amount for the sale. Sent only if enabled for your account.",
};

/** One row per system placeholder; a compile error if one is added without a meaning. */
export const POSTBACK_PLACEHOLDERS = SYSTEM_PLACEHOLDERS.map((name) => ({
  name,
  meaning: PLACEHOLDER_MEANING[name],
}));

/** Sales postbacks: our call to the partner's URL when a lead they sent buys. */
export const POSTBACK_DOC = {
  title: "Sales postbacks",
  intro:
    "If agreed, we notify a URL of yours when a lead you sent makes an approved purchase. " +
    "We make an HTTP GET to your https URL (port 443). Depending on your agreement, a " +
    "postback is sent for every approved purchase or only the first one per lead.",
  placeholderIntro:
    "Your URL is a template. Write any of these in curly braces and we fill them in, " +
    "together with your agreed passthrough field names (for example {your_field}). " +
    "Values are URL-encoded; a value we do not have renders empty.",
  exampleUrl:
    "https://example.com/postback?ref={your_field}&status={status}&conversion_id={conversion_id}",
  retryIntro:
    "Any 2xx response means delivered. A timeout, a 5xx, 408 or 429 is retried; other " +
    "responses are not. Redirects are not followed. Retries happen after:",
  retryDelaysMs: RETRY_DELAYS_MS,
  retryOutro: "After the last retry we stop.",
  rules: [
    "Delivery is at least once: the same sale can reach you more than once. De-duplicate on {conversion_id}.",
  ],
};

/**
 * Phone validation differs in sandbox. Stated once here and rendered by BOTH
 * partner-facing docs (the page and the generated markdown), so the two cannot
 * tell a partner different things about the same rule.
 */
export const SANDBOX_PHONE_NOTE =
  "Phone validation in sandbox checks format only: a well-formed number is accepted " +
  "even if its area code is not a real one, so test records such as " +
  "+1 555 555 0100 work. Length and structure are still enforced, and a malformed " +
  "number is still rejected. A live key requires a real, assigned number — switch " +
  "to genuine test numbers before activation.";

export interface SandboxStep {
  title: string;
  detail: string;
}

export const SANDBOX_STEPS: SandboxStep[] = [
  {
    title: "Receive credentials",
    detail:
      "The token is used in the URL, the secret in the header. The secret is " +
      "displayed once and cannot be recovered.",
  },
  {
    title: "Submit a single lead",
    detail: 'The endpoint returns 202 with "sandbox": true.',
  },
  {
    title: "Submit the same lead again",
    detail:
      'The response returns "duplicate": true and the original lead id, confirming ' +
      "idempotent retries.",
  },
  {
    title: "Submit a lead without a phone number",
    detail:
      'The response returns "status": "rejected" with an error. The lead is stored ' +
      "for inspection.",
  },
  {
    title: "Request activation",
    detail:
      'The key is switched live. URL, credentials and payload are unchanged; the ' +
      '"sandbox" flag becomes false.',
  },
];

export interface ChangelogEntry {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  changes: string[];
}

/**
 * Partner-visible API changelog, newest first.
 *
 * ⚠️ ANY PR THAT CHANGES INTAKE FIELDS, VALIDATION OR LIMITS MUST ADD AN ENTRY
 * HERE IN THE SAME PR. Partners integrate against this page; a silent change to
 * what we accept turns into "our leads started failing" with nothing to point
 * at. See docs/07-conventions.md.
 */
export const API_CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-31",
    changes: [
      "Added passthrough fields: extra field names agreed per partner are stored with the lead. Unknown fields are ignored; a value that does not fit the limits is dropped (the lead is kept) and reported in a `warnings` array on that lead's 202 entry.",
      "Added sales postbacks: an HTTP GET to your https URL when a lead you sent makes an approved purchase, with retries. No change to existing request fields or response codes.",
    ],
  },
  {
    date: "2026-10-01",
    changes: [
      "Sandbox keys now validate phone format only. A well-formed number with an " +
        "area code that is not real — for example +1 555 555 0100 — is accepted on a " +
        "sandbox key instead of being rejected. Malformed numbers are still rejected, " +
        "and live keys are unchanged and still require a real, assigned number.",
    ],
  },
  {
    date: "2026-08-24",
    changes: [
      "Published this reference. No change to the endpoint, fields or limits.",
    ],
  },
  {
    date: "2026-08-22",
    changes: [
      "Added demographic fields (dob, gender, income_band, married, kids). All optional.",
      "dob: epoch placeholders such as 1970-01-01 are treated as unknown and discarded.",
    ],
  },
  {
    date: "2026-08-21",
    changes: [
      `Batches of up to ${MAX_LEADS_PER_CALL} leads per call.`,
      "Leads failing validation are stored and returned with an error rather than dropped.",
      'Duplicate detection: a number resubmitted within the same minute returns the ' +
        'original lead id with "duplicate": true.',
    ],
  },
];
