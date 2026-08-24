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
  /** What the PARTNER should do. The whole point of the table. */
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
    meaning: "Accepted and stored. The response body reports what happened to each lead.",
    action: "Nothing. Reconcile by index against the `leads` array if you track ids.",
    retry: "no",
  },
  {
    status: 400,
    meaning: "The body was not valid JSON, or contained no leads.",
    action: "Fix the request. Do not retry it unchanged — it will fail identically.",
    retry: "no",
  },
  {
    status: 401,
    meaning: "The token or the secret is wrong.",
    action:
      "Check both credentials. Repeated failures on a valid token are alerted to us, " +
      "so contact us rather than retrying in a loop.",
    retry: "no",
  },
  {
    status: 403,
    meaning: "The key is recognised but has been disabled.",
    action: "Contact us. Retrying will not re-enable it.",
    retry: "no",
  },
  {
    status: 413,
    meaning:
      "The payload was too large, the batch held too many leads, or the batch " +
      "was larger than the whole daily allowance. The applicable limit is named in the response body.",
    action:
      "Split into smaller batches and resend. Nothing was stored, so no lead is lost.",
    retry: "yes",
  },
  {
    status: 429,
    meaning: "A rate limit was hit. Nothing at all was stored.",
    action:
      "Wait for the number of seconds in the `Retry-After` header, then resend the WHOLE batch. " +
      "A 429 does not consume any allowance, so being throttled never reduces what you can send later.",
    retry: "after-delay",
  },
  {
    status: 500,
    meaning: "We failed to store the leads.",
    action:
      "Retry. Duplicate protection makes a repeat safe, and we would rather receive a lead " +
      "twice than lose it.",
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
    title: "We send you a token and a secret",
    detail:
      "Both are secret. The token goes in the URL, the secret in the header. " +
      "The secret is shown once — if it is lost we issue a new one.",
  },
  {
    title: "Post one lead",
    detail: 'You should get a 202 with "sandbox": true in the body.',
  },
  {
    title: "Post the same lead again",
    detail:
      'You should get "duplicate": true and the SAME id back. This is how you prove ' +
      "your retries are safe.",
  },
  {
    title: "Post a lead with no phone number",
    detail:
      'You should get "status": "rejected" with an error explaining why. The lead is ' +
      "still stored so we can both see exactly what arrived.",
  },
  {
    title: "Tell us, and we switch the key live",
    detail:
      "Nothing about your request changes — same URL, same credentials, same payload. " +
      'Only the "sandbox" flag in the response flips to false.',
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
      "Published this page. No change to the API itself — the endpoint, fields and " +
        "limits are exactly as they have been since the integration opened.",
    ],
  },
  {
    date: "2026-08-22",
    changes: [
      "Added the demographic fields: date of birth, gender, income band, marital status " +
        "and children. All optional; sending them is not required and omitting them " +
        "changes nothing.",
      "Date of birth must be sent EMPTY when unknown. An epoch placeholder such as " +
        "1970-01-01 is treated as unknown and discarded rather than stored.",
    ],
  },
  {
    date: "2026-08-21",
    changes: [
      `Batches of up to ${MAX_LEADS_PER_CALL} leads per call.`,
      "Leads that fail validation are stored and reported back with an error, rather " +
        "than being silently dropped.",
      "Duplicate protection: the same number sent twice in the same minute returns the " +
        "same lead id with \"duplicate\": true, so retries cannot create a second lead.",
    ],
  },
];
