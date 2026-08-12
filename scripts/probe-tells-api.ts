import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// ============================================================================
// Tells.co Phase 0 — A-series send probes (A1–A8).
// See docs/superpowers/specs/2026-08-12-tells-provider-design.md §5.
// ============================================================================
//
// ⚠️ THIS SENDS REAL SMS AND COSTS REAL MONEY. Roughly 7 billable messages per
// full run (the A3/A4 probes are expected to be rejected before billing).
// Run --dry-run first to confirm the target number is the test handset.
//
// Run:
//   npx tsx scripts/probe-tells-api.ts --dry-run     # print requests, send nothing
//   npx tsx scripts/probe-tells-api.ts               # live
//   npx tsx scripts/probe-tells-api.ts A3 A5         # only the named probes
//
// Env (from .env.local or the real environment):
//   TELLS_API_KEY    required  the Tells API key
//   TELLS_FROM       required  our sending TFN
//   TELLS_TO         required  the TEST HANDSET — never a real contact
//   TELLS_TEST_LINK  optional  a real CamMan short link for A6; A6 skips without it
//   TELLS_API_URL    optional  default https://app.tells.co/api/sms.php
//
// Every call prints its HTTP STATUS CODE, response headers, elapsed time, and
// the raw body verbatim — the point of Phase 0 is the exact bytes, so nothing
// here is summarized or reshaped. The API KEY is the one thing redacted in the
// printed REQUEST line: it is not part of the payload contract we're
// establishing, and this output gets pasted into a transcript.
//
// The webhook side (B/C series) is not driven from here — those arrive at the
// temporary capture route and are read from Vercel runtime logs (spec §5.0).

const API_URL = process.env.TELLS_API_URL ?? "https://app.tells.co/api/sms.php";
const TIMEOUT_MS = 20000;

const DRY_RUN = process.argv.includes("--dry-run");
// Accepts "A3", "A1a", "A8-1". A bare group id selects its variants: "A1" runs
// A1a+A1b, "A8" runs A8-1+A8-2. Without the prefix match, `... A8` would match
// nothing and skip the duplicate-send probe silently.
const ONLY = process.argv.slice(2).filter((a) => /^A\d/i.test(a)).map((a) => a.toUpperCase());

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`✗ ${name} is not set. See the header of this file for the required env vars.`);
    process.exit(1);
  }
  return v;
}

const API_KEY = required("TELLS_API_KEY");
const FROM = required("TELLS_FROM");
const TO = required("TELLS_TO");
const TEST_LINK = (process.env.TELLS_TEST_LINK ?? "").trim() || null;

// --- output helpers ----------------------------------------------------------

const RULE = "─".repeat(78);

function redactKey(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => (k === "key" ? `key=<REDACTED len=${v.length}>` : `${k}=${JSON.stringify(v)}`))
    .join(" ");
}

interface CallResult {
  id: string;
  title: string;
  status: number; // 0 = network/timeout
  raw: string | null;
  parsed: Record<string, unknown> | null;
  elapsedMs: number;
  error: string | null;
}

const results: CallResult[] = [];

function selected(id: string): boolean {
  if (ONLY.length === 0) return true;
  const upper = id.toUpperCase();
  return ONLY.some((o) => upper === o || upper.startsWith(o));
}

async function call(id: string, title: string, params: Record<string, string>): Promise<CallResult | null> {
  if (!selected(id)) return null;

  console.log(`\n${RULE}\n${id}  ${title}`);
  console.log(`request  POST ${API_URL}`);
  console.log(`         ${redactKey(params)}`);

  if (DRY_RUN) {
    console.log("DRY RUN  nothing sent");
    return null;
  }

  const body = new URLSearchParams(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  let out: CallResult;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;

    let raw: string | null = null;
    try {
      raw = await res.text();
    } catch {
      raw = null;
    }
    let parsed: Record<string, unknown> | null = null;
    if (raw) {
      try {
        const p: unknown = JSON.parse(raw);
        parsed = p && typeof p === "object" ? (p as Record<string, unknown>) : null;
      } catch {
        parsed = null; // non-JSON body is itself a finding — raw still prints
      }
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    // HTTP STATUS IS THE HEADLINE — A3 exists to answer whether Tells uses real
    // status codes (Text Request does) or always returns 200 (Ahoi does).
    console.log(`HTTP     ${res.status}${res.status === 0 ? "" : ` ${res.statusText}`}`);
    console.log(`elapsed  ${elapsedMs}ms`);
    console.log(`headers  ${JSON.stringify(headers)}`);
    console.log(`body ▼`);
    console.log(raw ?? "(no body)");
    if (raw && parsed === null) console.log("(note: body did NOT parse as JSON)");

    out = { id, title, status: res.status, raw, parsed, elapsedMs, error: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const elapsedMs = Date.now() - started;
    console.log(`HTTP     0 (${aborted ? "timeout" : "network error"})`);
    console.log(`elapsed  ${elapsedMs}ms`);
    out = {
      id,
      title,
      status: 0,
      raw: null,
      parsed: null,
      elapsedMs,
      error: aborted ? "timeout" : "network error",
    };
  } finally {
    clearTimeout(timer);
  }

  results.push(out);
  return out;
}

// --- probes ------------------------------------------------------------------

async function main() {
  // Probes expected to actually bill: A1a, A1b, A5, A7a, A7b, A8-1, A8-2 (+A6
  // when a test link is set). A3/A4 should be rejected before billing — whether
  // they truly are is itself a Phase 0 finding (cf. C4).
  const billableIds = ["A1a", "A1b", "A5", "A7a", "A7b", "A8-1", "A8-2", ...(TEST_LINK ? ["A6"] : [])];
  const billable = billableIds.filter(selected).length;
  console.log(RULE);
  console.log("Tells.co Phase 0 — A-series send probes");
  console.log(`endpoint   ${API_URL}`);
  console.log(`from       ${FROM}`);
  console.log(`to         ${TO}   <-- confirm this is the TEST HANDSET`);
  console.log(`link (A6)  ${TEST_LINK ?? "(TELLS_TEST_LINK unset — A6 will be SKIPPED)"}`);
  console.log(`mode       ${DRY_RUN ? "DRY RUN (nothing sent)" : `LIVE — about ${billable} billable messages`}`);
  if (ONLY.length) console.log(`only       ${ONLY.join(", ")}`);
  console.log(RULE);

  // A1 — number format. Doc examples show bare 11-digit; Text Request accepted
  // "+1…" but echoed the bare form. Whichever Tells accepts drives
  // toTellsRecipient().
  const a1a = await call("A1a", "number format: to = E.164 (+1XXXXXXXXXX)", {
    key: API_KEY,
    from: FROM,
    to: TO.startsWith("+") ? TO : `+${TO.replace(/\D/g, "")}`,
    message: "CamMan probe A1a e164",
  });

  await call("A1b", "number format: to = bare 11-digit (1XXXXXXXXXX)", {
    key: API_KEY,
    from: FROM,
    to: TO.replace(/\D/g, ""),
    message: "CamMan probe A1b bare11",
  });

  // A2 — no send of its own: it is an observation on A1a's success body.
  // Prints the JS type of every field so "is id "3" or 3?" is answered by
  // evidence rather than by eyeballing quotes in the raw dump.
  if (selected("A2") && a1a?.parsed) {
    console.log(`\n${RULE}\nA2  success-body field types (derived from A1a — no extra send)`);
    for (const [k, v] of Object.entries(a1a.parsed)) {
      console.log(`         ${k}: ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v} = ${JSON.stringify(v)}`);
    }
    console.log("         ^ note the KEY CASING too: send response is documented lowercase,");
    console.log("           webhooks PascalCase. Confirm against the B-series captures.");
  } else if (selected("A2")) {
    console.log(`\n${RULE}\nA2  skipped — A1a produced no parsable success body to inspect`);
  }

  // A3 — THE decisive probe for send classification. Ahoi always returns HTTP
  // 200 and the real result is in the body; Text Request returns real codes.
  // Getting this wrong misclassifies every send.
  await call("A3", "bad API key — DOES TELLS USE REAL HTTP STATUS CODES? (watch HTTP above)", {
    key: `${API_KEY}-invalid-probe-a3`,
    from: FROM,
    to: TO,
    message: "CamMan probe A3 badkey",
  });

  // A4 — sender validation. Determines whether the adapter's no-sender refusal
  // is the only guard needed before a send is attempted.
  await call("A4a", "from = a number NOT on the account", {
    key: API_KEY,
    from: "12025550143", // NANP 555 reserved range — never a real subscriber
    to: TO,
    message: "CamMan probe A4a bad from",
  });

  await call("A4b", "from omitted entirely", {
    key: API_KEY,
    to: TO,
    message: "CamMan probe A4b no from",
  });

  // A5 — segmentation. Ahoi split multi-segment sends and emitted EXTRA DLRs
  // under different uuids, which broke 1:1 DLR correlation. Check whether
  // sms_count reflects segments and whether one id or several come back.
  const longText =
    "CamMan probe A5 segmentation test. " +
    "This message is deliberately longer than one hundred and sixty characters so that the provider has to split it into multiple SMS segments to deliver it.";
  await call("A5", `message > 160 chars (actual length ${longText.length}) — sms_count / sms_charge / how many ids?`, {
    key: API_KEY,
    from: FROM,
    to: TO,
    message: longText,
  });

  // A6 — link passthrough. If Tells rewrites, shortens or wraps URLs, our
  // click attribution dies silently.
  if (TEST_LINK) {
    await call("A6", "short-link passthrough — compare the RECEIVED text against this exactly", {
      key: API_KEY,
      from: FROM,
      to: TO,
      message: `CamMan probe A6 link ${TEST_LINK}`,
    });
  } else if (selected("A6")) {
    console.log(`\n${RULE}\nA6  SKIPPED — set TELLS_TEST_LINK to a real CamMan short link (…/r/<code>)`);
    console.log("    This probe matters: if Tells rewrites URLs, attribution breaks silently.");
  }

  // A7 — metadata. This is the DLR correlation channel for Phase 2 (Tells's
  // webhook URL is account-level, so there is no per-send callback like Text
  // Request's status_callback). A7b uses the real Phase 2 shape.
  await call("A7a", "metadata as a plain string", {
    key: API_KEY,
    from: FROM,
    to: TO,
    message: "CamMan probe A7a meta-string",
    metadata: "camman-probe-a7a-string",
  });

  await call("A7b", "metadata as a JSON object (the actual Phase 2 shape)", {
    key: API_KEY,
    from: FROM,
    to: TO,
    message: "CamMan probe A7b meta-json",
    metadata: JSON.stringify({
      stage_send_id: "00000000-0000-0000-0000-000000000000",
      probe: "a7b",
    }),
  });

  // A8 — no provider-side dedup and no idempotency key means a timeout-retry in
  // the drain is a potential DOUBLE SEND. Two byte-identical requests.
  const dupText = "CamMan probe A8 duplicate";
  await call("A8-1", "identical message, send 1 of 2", {
    key: API_KEY, from: FROM, to: TO, message: dupText,
  });
  await call("A8-2", "identical message, send 2 of 2 — did the handset receive BOTH?", {
    key: API_KEY, from: FROM, to: TO, message: dupText,
  });

  // --- summary ---------------------------------------------------------------

  if (DRY_RUN) {
    console.log(`\n${RULE}\nDRY RUN complete — nothing was sent.`);
    return;
  }

  console.log(`\n${RULE}\nSUMMARY (HTTP status per probe)\n${RULE}`);
  for (const r of results) {
    const bodyStatus = typeof r.parsed?.status === "string" ? r.parsed.status : "—";
    const id = r.parsed?.id != null ? String(r.parsed.id) : "—";
    console.log(
      `${r.id.padEnd(6)} HTTP ${String(r.status).padEnd(4)} body.status=${String(bodyStatus).padEnd(9)} id=${id.padEnd(12)} ${r.elapsedMs}ms${r.error ? `  (${r.error})` : ""}`,
    );
  }

  const codes = new Set(results.map((r) => r.status));
  console.log(`\n${RULE}`);
  console.log("READ THIS BEFORE MOVING ON:");
  console.log(
    codes.size === 1 && codes.has(200)
      ? "  • Every call returned HTTP 200, INCLUDING A3's bad key ⇒ Tells is Ahoi-shaped:\n" +
        "    classify off the BODY, never the HTTP status."
      : `  • Distinct HTTP statuses observed: ${[...codes].sort().join(", ")} ⇒ Tells appears to use\n` +
        "    real status codes (Text Request-shaped). Classification keys off HTTP AND body.",
  );
  console.log("  • Now check the handset: which probes actually ARRIVED, and did A6's link survive?");
  console.log("  • Then the B/C series: capture route + Vercel runtime logs (spec §5.0).");
  console.log(RULE);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
