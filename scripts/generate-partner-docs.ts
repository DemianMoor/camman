import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { LEAD_FIELDS, MAX_LEADS_PER_CALL } from "@/lib/intake/fields";

// Generates docs/partners/lead-intake.md FROM lib/intake/fields.ts.
//
// ⭐ Risk R19 is that the partner-facing document drifts from what the endpoint
// actually accepts — a partner then integrates against a lie, and the failure
// surfaces as "their leads are all rejected" days later. The doc is therefore
// not hand-written: it is generated from the same LEAD_FIELDS map the intake
// route validates against, exactly as the segment-rules system uses RULE_TYPES
// as the single source for server and client.
//
//   npx tsx scripts/generate-partner-docs.ts          # write
//   npx tsx scripts/generate-partner-docs.ts --check  # fail if out of date
//
// The --check form runs in CI/pre-merge so an edit to the field list that
// forgets to regenerate cannot land.

const OUT = resolve(process.cwd(), "docs/partners/lead-intake.md");

function render(): string {
  const rows = LEAD_FIELDS.map((f) => {
    const aliases = f.aliases.length ? f.aliases.map((a) => `\`${a}\``).join(", ") : "—";
    const allowed = f.allowed ? f.allowed.map((a) => `\`${a}\``).join(" · ") : "";
    const notes = [f.notes ?? "", allowed ? `Allowed: ${allowed}` : ""]
      .filter(Boolean)
      .join(" ")
      .replace(/\|/g, "\\|");
    return `| \`${f.key}\` | ${f.label} | ${f.type} | ${
      f.required ? "**yes**" : "no"
    } | ${aliases} | \`${f.example}\` | ${notes} |`;
  }).join("\n");

  return `# Sending leads to CamMan

_Generated from \`lib/intake/fields.ts\` by \`scripts/generate-partner-docs.ts\` — do not edit by hand._

You post leads to a URL we give you. We store them and reply immediately; nothing
else happens on the call, so it is fast and safe to retry.

## Endpoint

\`\`\`
POST https://<your-camman-host>/api/intake/leads/<YOUR_TOKEN>
Content-Type: application/json
Authorization: Bearer <YOUR_SECRET>
\`\`\`

You receive **two** values from us. Both are secret:

| Value | Where it goes | Notes |
|---|---|---|
| **Token** | in the URL path | Identifies you. Not a password on its own. |
| **Secret** | in the \`Authorization\` header | Proves it is you. Shown to us once; if you lose it we must issue a new one. |

\`X-Partner-Secret: <YOUR_SECRET>\` works instead of \`Authorization\` if that is
easier. **Never put the secret in the JSON body** — we do not read it there, and
the body is stored as-is.

## Body

A single lead object, or an array of up to **${MAX_LEADS_PER_CALL}** of them.

\`\`\`json
{ "phone": "+12025550199", "first_name": "Jane", "interest_tag": "ACA" }
\`\`\`

\`\`\`json
[
  { "phone": "+12025550199", "first_name": "Jane" },
  { "phone": "+12025550111", "first_name": "John" }
]
\`\`\`

Only \`phone\` is required. Send whatever else you have — **unknown fields are
kept**, not discarded, so nothing is lost if you send more than the list below.

## Fields

| Field | Meaning | Type | Required | Also accepted as | Example | Notes |
|---|---|---|---|---|---|---|
${rows}

If your field names differ from ours, tell us and we map them on our side — you
do not need to change your payload.

## Responses

| Status | Meaning | What to do |
|---|---|---|
| \`202\` | Accepted and stored. | Nothing. |
| \`400\` | Body was not valid JSON. | Fix the request; do not retry unchanged. |
| \`401\` | Token or secret wrong. | Check credentials. Repeated failures alert us. |
| \`403\` | Your key is disabled. | Contact us. |
| \`413\` | Payload or batch too large. | Split into smaller batches. The limit is in the response body. |
| \`429\` | Rate limit hit. | Wait and retry — see \`Retry-After\`. Nothing was stored, so resend the whole batch. |
| \`500\` | We failed to store it. | **Retry.** We would rather have it twice than not at all. |

A \`202\` body looks like:

\`\`\`json
{
  "accepted": 2,
  "duplicates": 0,
  "rejected": 0,
  "sandbox": true,
  "leads": [
    { "id": "…", "status": "received", "duplicate": false },
    { "id": "…", "status": "received", "duplicate": false }
  ]
}
\`\`\`

\`leads\` is in the same order you sent them, so you can reconcile by index.

### Duplicates are safe

The same phone number sent twice within the same minute resolves to the **same
stored lead**, and you get its id back with \`"duplicate": true\`. So retrying
after a timeout cannot create a second lead — retry freely.

### Rejected leads are still stored

A lead with a missing or unparseable phone comes back as
\`"status": "rejected"\` with an \`error\`. We keep it rather than dropping it, so
we can show you exactly what arrived when an integration is misbehaving. It is
not processed further.

## Rate limits

Two separate limits, and they count different things:

- **Per second** — counts **requests**. A batch of 500 is one request.
- **Per day** — counts **leads**. A batch of 500 costs 500. Resets at midnight
  US Eastern.

A \`429\` stores nothing at all, and does **not** consume your daily budget — so
being rate-limited never eats into what you can send later that day.

## Sandbox

Every new key starts in **sandbox**. Sandbox leads are stored and clearly
flagged, but are never messaged and are excluded from reporting. Use it to prove
your integration end to end: you will see real ids, real duplicate detection and
real validation errors, with no possibility of a message going out.

When you are ready, we switch the key live. **Nothing about your request
changes** — same URL, same credentials, same payload.

## Getting started

1. We send you a token and a secret.
2. Post one lead. You should get \`202\` with \`"sandbox": true\`.
3. Post the same lead again — you should get \`"duplicate": true\`.
4. Post one with no phone — you should get \`"status": "rejected"\`.
5. Tell us, and we switch you live.
`;
}

const content = render();
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`MISSING: ${OUT}\nRun: npx tsx scripts/generate-partner-docs.ts`);
    process.exit(1);
  }
  // Compare ignoring line endings — the repo checks out CRLF on Windows and a
  // byte compare would fail for a reason that has nothing to do with drift.
  if (current.replace(/\r\n/g, "\n") !== content) {
    console.error(
      `OUT OF DATE: ${OUT}\n` +
        `lib/intake/fields.ts changed without regenerating the partner doc.\n` +
        `Run: npx tsx scripts/generate-partner-docs.ts`,
    );
    process.exit(1);
  }
  console.log("docs/partners/lead-intake.md is in sync with lib/intake/fields.ts ✓");
} else {
  mkdirSync(resolve(process.cwd(), "docs/partners"), { recursive: true });
  writeFileSync(OUT, content, "utf8");
  console.log(`wrote ${OUT} (${LEAD_FIELDS.length} fields)`);
}
