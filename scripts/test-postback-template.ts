import { postbackConfigError, renderPostbackUrl, maskUrl, samplePayload, type PostbackPayload } from "@/lib/partners/postbacks/template";

// Pure-function test for the postback URL template. No DB.

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
}

const base: PostbackPayload = {
  event: "purchase", status: "approved", conversion_id: "c1", occurred_at: "2026-10-30T00:00:00.000Z",
  currency: "USD", payout: "12.50", fields: { relay_lead_id: "a b&c" },
};
const T = "https://p.example/pb?rid={relay_lead_id}&s={status}&c={conversion_id}";

// T1 encoding
check("T1 render encodes", renderPostbackUrl(T, base, false), "https://p.example/pb?rid=a%20b%26c&s=approved&c=c1");

// T2 missing value
check("T2 missing field -> empty", renderPostbackUrl(T, { ...base, fields: {} }, false), "https://p.example/pb?rid=&s=approved&c=c1");

// T3 payout gating
const P = "https://p.example/pb?p={payout}";
check("T3 payout off", renderPostbackUrl(P, base, false), "https://p.example/pb?p=");
check("T3 payout on", renderPostbackUrl(P, base, true), "https://p.example/pb?p=12.50");

// T4 config validation
const f = ["relay_lead_id"];
const err = (template: string, includePayout = false) => postbackConfigError({ template, passthroughFields: f, includePayout });
check("T4 valid", err(T), null);
check("T4 http", err("http://p.example/pb?x={status}"), "Postback URL must use https");
check("T4 port", err("https://h:8443/pb"), "Postback URL port must be 443");
check("T4 port 443 ok", err("https://h:443/pb"), null);
check("T4 case-sensitive", err("https://h/pb?r={Relay_Lead_ID}"), "Unknown placeholder {Relay_Lead_ID}");
check("T4 unknown", err("https://h/pb?r={relay_lead}"), "Unknown placeholder {relay_lead}");
check("T4 lone {", err("https://h/pb?r={"), "Unbalanced { in template");
check("T4 stray }", err("https://h/pb?r=}"), "Unbalanced { in template");
check("T4 payout off", err("https://h/pb?p={payout}"), "{payout} needs \u201cInclude payout\u201d switched on");
check("T4 payout on", err("https://h/pb?p={payout}", true), null);
check("T4 userinfo", err("https://u:p@h/pb"), "Postback URL must not contain credentials");
check("T4 too long", err("https://h/" + "a".repeat(2048)), "Postback URL template is longer than 2048 characters");
check("T4 not a url", err("nonsense") !== null, true);

// F1 authority placeholders
const AUTH = "Placeholders are only allowed in the path or query";
check("F1 host placeholder", err("https://{relay_lead_id}/pb"), AUTH);
check("F1 host only", err("https://{relay_lead_id}"), AUTH);
check("F1 host suffix", err("https://p.example{relay_lead_id}/"), AUTH);
check("F1 port", err("https://h:{status}/pb"), AUTH);
check("F1 scheme", err("{status}://h/pb"), AUTH);
check("F1 path/fragment ok", err("https://h/{status}/x#{event}"), null);
let threw = false;
try { renderPostbackUrl("https://{relay_lead_id}/pb", { ...base, fields: { relay_lead_id: "evil.com" } }, false); } catch { threw = true; }
check("F1 render host mismatch throws", threw, true);
threw = false;
try { renderPostbackUrl("https://{relay_lead_id}/pb", { ...base, fields: {} }, false); } catch { threw = true; }
check("F1 render empty host throws", threw, true);

// F2 lone surrogate does not throw
check("F2 lone surrogate", renderPostbackUrl(T, { ...base, fields: { relay_lead_id: "\ud800" } }, false), "https://p.example/pb?rid=%EF%BF%BD&s=approved&c=c1");

// T5 masking
check("T5 mask", maskUrl("https://h/pb?token=abc&rid=1&api_key=z&sig=q"), "https://h/pb?token=***&rid=1&api_key=***&sig=***");
check("T5 untouched params byte-identical", maskUrl("https://h/pb?rid=a%20b&x=%zz"), "https://h/pb?rid=a%20b&x=%zz");
check("T5 unparseable masks query", maskUrl("not a url?rid=1&z=2"), "not a url?***");

check("T5 repeated", maskUrl("https://h/pb?token=a&token=b"), "https://h/pb?token=***&token=***");
check("T5 case-insensitive", maskUrl("https://h/pb?API_KEY=z"), "https://h/pb?API_KEY=***");

// samplePayload
const s = samplePayload(["list_id"]);
check("S1 sample", [s.fields, s.status, s.payout, s.currency, s.conversion_id.startsWith("test-")], [{ list_id: "test_list_id" }, "approved", "0.00", "USD", true]);

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nAll passed");
