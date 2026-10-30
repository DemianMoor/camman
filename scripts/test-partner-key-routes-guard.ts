import { readFileSync } from "node:fs";

// Source guard for the partner-key postback routes. Their auth glue (requireApiMembership
// reads cookies) can't be substituted cleanly in a tsx script, so the route-level decisions
// are pinned by source: the permission check precedes every DB/side-effecting call, the
// 403/404/409/429 branches exist, and every query the routes reach is org-filtered.

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
}
const read = (p: string) => readFileSync(p, "utf8");

const TEST_ROUTE = "app/api/partner-keys/[keyId]/postback-test/route.ts";
const LOG_ROUTE = "app/api/partner-keys/[keyId]/postbacks/route.ts";
const PATCH_ROUTE = "app/api/partner-keys/[keyId]/route.ts";
const CAN = /can\(role, "partner_keys\.manage"\)/;

/** The index of the first call that touches data or sends, or -1. */
function firstDataCall(src: string): number {
  const idx = [/\bdb\s*\.\s*(select|execute|update|insert)/, /sendTestPostback\(/, /listKeyPostbacks\(/, /applyPartnerKeyPatch\(/, /deliveryEnabled\(\)/]
    .map((re) => src.search(re))
    .filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : -1;
}

for (const [name, path] of [["postback-test", TEST_ROUTE], ["postbacks", LOG_ROUTE], ["PATCH key", PATCH_ROUTE]] as const) {
  const src = read(path);
  const c = src.search(CAN);
  const d = firstDataCall(src);
  check(`${name}: can(role, "partner_keys.manage") present`, c >= 0);
  check(`${name}: permission check precedes every DB/send call`, c >= 0 && d > c);
  check(`${name}: 403 on failure`, /apiError\(403, "Forbidden"/.test(src));
  check(`${name}: requireApiMembership first`, src.indexOf("requireApiMembership()") >= 0 && src.indexOf("requireApiMembership()") < c);
}

const test = read(TEST_ROUTE);
check("postback-test: 409 kill-switch message", test.includes('apiError(409, "Postback delivery is switched off"'));
check("postback-test: kill switch checked before sending", test.indexOf("deliveryEnabled()") > 0 && test.indexOf("deliveryEnabled()") < test.indexOf("sendTestPostback("));
check("postback-test: 429 on too_soon", test.includes('"too_soon" in out') && test.includes('apiError(429, "Wait a few seconds between test sends"'));
check("postback-test: 404 for a key outside the org", test.includes('apiError(404, "Partner key not found"'));
check("postback-test: 400 without a template", test.includes('apiError(400, "Save a postback URL template first"'));
check("postback-test: orgId passed to sendTestPostback", /sendTestPostback\(db, \{ orgId, keyId \}\)/.test(test));

const log = read(LOG_ROUTE);
check("postbacks: key looked up WITH org filter, 404 otherwise", /partner_keys\.org_id, orgId/.test(log) && log.includes('apiError(404, "Partner key not found"'));
check("postbacks: listKeyPostbacks gets orgId", /listKeyPostbacks\(db, \{\s*orgId, keyId/.test(log));

const patch = read(PATCH_ROUTE);
check("PATCH: delegates with orgId", /applyPartnerKeyPatch\(db, \{ orgId, keyId, input \}\)/.test(patch));

// Every statement in the functions the routes call filters by org.
const deliver = read("lib/partners/postbacks/deliver.ts");
const tail = deliver.slice(deliver.indexOf("export async function sendTestPostback"));
const ORG = "org_id = ${o.orgId}::uuid";
check("sendTestPostback: key select is org-filtered", /FROM partner_keys WHERE id = [^\n]*AND org_id = \$\{o\.orgId\}::uuid/.test(tail));
check("sendTestPostback: recent-row check is org-filtered", /FROM partner_postbacks\s+WHERE org_id = \$\{o\.orgId\}::uuid/.test(tail));
check("sendTestPostback: insert writes the caller's org", /INSERT INTO partner_postbacks[\s\S]*?VALUES \(\$\{o\.orgId\}::uuid/.test(tail));
check("sendTestPostback: result update is org-filtered", /UPDATE partner_postbacks[\s\S]*?AND org_id = \$\{o\.orgId\}::uuid/.test(tail) && tail.includes(ORG));
const cfg = read("lib/partners/postbacks/config.ts");
const listFn = cfg.slice(cfg.indexOf("export async function listKeyPostbacks"));
check("listKeyPostbacks: org + key filter", /org_id = \$\{o\.orgId\}::uuid/.test(listFn) && /partner_key_id = \$\{o\.keyId\}/.test(listFn));
const patchFn = cfg.slice(0, cfg.indexOf("export type PostbackLogRow"));
check("applyPartnerKeyPatch: select and update both org-filtered", (patchFn.match(/eq\(partner_keys\.org_id, orgId\)/g) ?? []).length === 2);

// The delivery runner must never claim test rows (sendTestPostback leaves a pending row mid-send).
check("runner claims only NOT is_test rows", /status = 'pending' AND NOT is_test AND next_attempt_at <= now\(\)/.test(deliver));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
