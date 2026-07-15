// ahoiAdapter.parseDlr / parseInbound — pure functions, no DB, no network.
// Field shapes are Phase 0 recon facts (form-encoded POST bodies).
// Run: npx tsx scripts/test-ahoi-parse.ts
import { ahoiAdapter, extractAhoiWebhookFields } from "@/lib/sends/providers/ahoi";
import type { RawWebhook } from "@/lib/sends/providers/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function raw(body: string, query: Record<string, string> = {}): RawWebhook {
  return { query, body, headers: {} };
}

// ---- extractAhoiWebhookFields ----
const merged = extractAhoiWebhookFields(raw("a=1&b=2", { c: "3" }));
check("merges query + form body", merged.a === "1" && merged.b === "2" && merged.c === "3", JSON.stringify(merged));
const bodyWins = extractAhoiWebhookFields(raw("a=body", { a: "query" }));
check("body wins over query on key collision", bodyWins.a === "body");

// ---- parseDlr ----
// Observed live (Phase 0 recon): intermediate + final callbacks.
const intermediate = ahoiAdapter.parseDlr(raw(
  "uuid=s-abc123-05152026&source=3158359592&destination=5642155963&send_status=carrier_sent&status=sent&smpp_status=sent&smpp_code=&error=000",
));
check("intermediate DLR parses", intermediate !== null);
check("intermediate providerUuid", intermediate?.providerUuid === "s-abc123-05152026");
check("intermediate sendStatus", intermediate?.sendStatus === "carrier_sent");
check("intermediate status", intermediate?.status === "sent");
check("intermediate smppStatus", intermediate?.smppStatus === "sent");
check("intermediate error", intermediate?.error === "000");

const final = ahoiAdapter.parseDlr(raw(
  "uuid=s-abc123-05152026&source=3158359592&destination=5642155963&send_status=delivered&status=delivered&smpp_status=DELIVRD&smpp_code=&error=000",
));
check("final DLR: status is lowercase 'delivered'", final?.status === "delivered");
check("final DLR: smppStatus carries the real spelling DELIVRD", final?.smppStatus === "DELIVRD");

// Multi-segment extra: numeric-only uuid, still parses (reconcile handles the
// non-match separately — parseDlr's job is just to extract the fields).
const numericUuid = ahoiAdapter.parseDlr(raw(
  "uuid=4131784060328527222&source=3158359592&destination=5642155963&send_status=delivered&status=delivered&smpp_status=DELIVRD&error=000",
));
check("numeric-uuid multi-segment extra still parses", numericUuid?.providerUuid === "4131784060328527222");

// Empty smpp_code/error -> null, not empty string (cleaner downstream logic).
check("empty smpp_code -> null", intermediate?.smppCode === null);

// Missing uuid -> null (nothing to reconcile against).
const noUuid = ahoiAdapter.parseDlr(raw("source=3158359592&destination=5642155963&send_status=sent&status=sent"));
check("DLR with no uuid -> null (can't reconcile)", noUuid === null);

// Doc-inferred rejected/600 shape (O1 — never observed live, written defensively).
const rejected = ahoiAdapter.parseDlr(raw("uuid=s-xyz-05152026&send_status=rejected&status=rejected&error=600"));
check("doc-inferred rejected DLR still parses (defensive)", rejected?.sendStatus === "rejected");

// ---- parseInbound ----
const inbound = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Hello&type=sms&cost=0"));
check("inbound parses", inbound !== null);
check("inbound source", inbound?.source === "5642155963");
check("inbound destination", inbound?.destination === "3158359592");
check("inbound message", inbound?.message === "Hello");
check("inbound type", inbound?.type === "sms");

// Form/URL-encoded message (recon fact: %0A=newline, +=space) — proven via
// standard URLSearchParams decoding, no custom decode step needed.
const encoded = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Stop+please%0Athanks&type=sms"));
check("form-encoded message decodes (+ -> space, %0A -> newline)", encoded?.message === "Stop please\nthanks", JSON.stringify(encoded));

// Bare "Stop" (recon: Ahoi forwards this, doesn't swallow it).
const bareStop = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Stop&type=sms"));
check("bare Stop message parses (keyword matching is Section 4's job, not this)", bareStop?.message === "Stop");

// Missing source/destination -> null.
const noSource = ahoiAdapter.parseInbound(raw("destination=3158359592&message=Hi"));
check("inbound with no source -> null", noSource === null);

// type defaults to "sms" when absent.
const noType = ahoiAdapter.parseInbound(raw("source=5642155963&destination=3158359592&message=Hi"));
check("missing type defaults to 'sms'", noType?.type === "sms");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
