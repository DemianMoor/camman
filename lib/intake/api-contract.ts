import { LEAD_FIELDS, MAX_LEADS_PER_CALL } from "./fields";

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
    action: "Split into smaller batches and resend. No leads were stored.",
    retry: "yes",
  },
  {
    status: 429,
    meaning: "A rate limit was exceeded. No leads were stored.",
    action:
      "Wait the interval given in `Retry-After`, then resend the full batch. " +
      "Allowance is not consumed.",
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
