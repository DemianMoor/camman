// Descriptor contract tests (869egmakh P1). No network, no DB — pure.
//
// The Ahoi cases are the VERBATIM bodies measured by scripts/probe-ahoi-badkey.ts
// on 2026-08-17. They are the regression guard: if api19 changes its error
// envelope, the classifier must degrade to `unknown`, never to a false `valid`.
import {
  getAdapter,
  getDescriptor,
  listConnectionTypes,
} from "@/lib/sends/providers/registry";
import { classifyAhoiCdrBody } from "@/lib/sends/providers/ahoi";
import { PER_NUMBER_RATE_NOTE } from "@/lib/sends/providers/types";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

console.log("\n── Ahoi CDR body classifier (fixtures = measured P0 bodies) ──");
// Measured: valid key, quiet day — header only, no data rows.
check(
  "valid key -> CSV header",
  classifyAhoiCdrBody(
    "date,your_cost,submaster_id,user_id,submaster_cost,user_cost,surcharge,src,dst,message,direction,alpha,msg_type,uuid\n",
  ).state,
  "valid",
);
// Measured: wrong key, same shape as the real one.
check(
  "wrong key -> JSON error envelope",
  classifyAhoiCdrBody('{"status":"error","error":"not logged in"}').state,
  "invalid",
);
// Measured: empty key (different message, same verdict — we key off `status`).
check(
  "empty key -> pretty-printed JSON error envelope",
  classifyAhoiCdrBody(
    '{\n    "status": "error",\n    "error": "invalid key",\n    "verbose": "none"\n}',
  ).state,
  "invalid",
);
// A valid key WITH data must still classify valid (the quiet-day fixture above
// has zero rows; this proves row count is not what's being read).
check(
  "valid key with data rows -> valid",
  classifyAhoiCdrBody(
    "date,your_cost,submaster_id,user_id,submaster_cost,user_cost,surcharge,src,dst,message,direction,alpha,msg_type,uuid\n" +
      "08/14/2026,0.0035,1,2,0.001,0.002,0,5551112222,5553334444,hi,out,,sms,s-a-b-c-d-e-08142026\n",
  ).state,
  "valid",
);

console.log("\n── Degradation: unrecognized shapes must be `unknown`, never `valid` ──");
check("empty body", classifyAhoiCdrBody("").state, "unknown");
check("whitespace only", classifyAhoiCdrBody("   \n ").state, "unknown");
check("HTML error page", classifyAhoiCdrBody("<html><body>502</body></html>").state, "unknown");
// The critical one: a FUTURE envelope change must not read as success.
check(
  "future JSON envelope (no `status` field)",
  classifyAhoiCdrBody('{"result":"failure","reason":"bad key"}').state,
  "unknown",
);
check(
  "JSON success envelope we don't know",
  classifyAhoiCdrBody('{"status":"ok","data":[]}').state,
  "unknown",
);
check(
  "arbitrary CSV that is not the CDR export",
  classifyAhoiCdrBody("foo,bar\n1,2\n").state,
  "unknown",
);

console.log("\n── Registry: alias resolution + canonical list ──");
// The txh2 ALIAS is GONE (retired with migration 0134's cutover). A provider row
// is now looked up by its adapter_code, so the txh2 ROW resolves via 'txh' — and
// the bare identity string must NOT resolve, or the alias is secretly back.
check("getDescriptor('txh2') no longer resolves (alias retired)", getDescriptor("txh2"), null);
check("getDescriptor('txh') resolves", getDescriptor("txh")?.displayName, "TextHub");
check("getDescriptor('nope') is null", getDescriptor("nope"), null);
// ...but must NOT appear as its own pickable connection type.
const types = listConnectionTypes();
check(
  "listConnectionTypes lists each connection type exactly once",
  types.map((t) => t.key).sort(),
  ["ahi", "tls", "txh", "txr"],
);
check("TextHub appears exactly once", types.filter((t) => t.descriptor.displayName === "TextHub").length, 1);
check(
  "every adapter in the registry declares a descriptor",
  ["txh", "ahi", "txr", "tls"].filter((k) => !getAdapter(k).descriptor),
  [],
);

console.log("\n── can_validate honesty ──");
const byKey = Object.fromEntries(types.map((t) => [t.key, t.canValidate]));
check("txh can validate (inbox read)", byKey.txh, true);
check("ahi can validate (CDR read)", byKey.ahi, true);
check("txr can validate (dashboards read)", byKey.txr, true);
// Tells has exactly one endpoint and it SENDS — no honest non-sending check.
check("tls canNOT validate (send-only API)", byKey.tls, false);

console.log("\n── Provider-specific action capabilities (P2 server-side gates) ──");
// Both routes call TextHub's client directly, so ONLY the TextHub family may
// have these on. If a future adapter flips one without implementing its branch
// in the route, this fails — which is the point.
for (const k of ["txh"]) {
  check(`${k}: supportsTestSend`, getDescriptor(k)!.supportsTestSend, true);
  check(`${k}: supportsOptOutCallbackRegistration`, getDescriptor(k)!.supportsOptOutCallbackRegistration, true);
}
for (const k of ["ahi", "txr", "tls"]) {
  check(`${k}: supportsTestSend NOT set`, getDescriptor(k)!.supportsTestSend, undefined);
  check(`${k}: supportsOptOutCallbackRegistration NOT set`, getDescriptor(k)!.supportsOptOutCallbackRegistration, undefined);
}

console.log("\n── Seams declared-but-unset (no speculative values) ──");
// Q3 (card 869ej8r1y) owns the opt-out-footer precedence chain and has NOT
// shipped, so these two must stay unset on every adapter — a value here would
// silently change rendered message text.
for (const k of ["txh", "ahi", "txr", "tls"]) {
  const d = getDescriptor(k)!;
  check(`${k}: defaultOptOutFooter unset`, d.defaultOptOutFooter, undefined);
  check(`${k}: appendsOwnOptOut unset`, d.appendsOwnOptOut, undefined);
}

// ⚠️ RETIRED ASSERTION. This block used to assert `phoneSettingFields unset` on
// all four adapters. Q2 gave Text Request a real `dashboard_id` field, which is
// the entire point of Q2 — so the invariant expired the moment it shipped, and
// this suite has been failing on main ever since. Per docs/07-conventions.md the
// fix is to retire the obsolete assertion, not to null out the data: it is
// replaced by the precise statement of what is true NOW — txr declares exactly
// one field, and nothing else declares any.
console.log("\n── Per-number setting fields (Q2: txr only) ──");
const txrPhoneFields = getDescriptor("txr")!.phoneSettingFields;
check("txr: declares phoneSettingFields", Array.isArray(txrPhoneFields), true);
check("txr: declares exactly one", txrPhoneFields?.length, 1);
check("txr: the field is dashboard_id", txrPhoneFields?.[0]?.name, "dashboard_id");
for (const k of ["txh", "ahi", "tls"]) {
  check(`${k}: phoneSettingFields unset`, getDescriptor(k)!.phoneSettingFields, undefined);
}

// ── Operator notes (R3) ────────────────────────────────────────────────────
// These are rendered verbatim to an operator on /settings/providers, so the
// contract is about substance, not just presence: real content, no blanks, and
// the universal per-number-rate note on every type (operators reliably look for
// the rate limit on the provider, and it is not there).
console.log("\n── Operator notes ──");
for (const k of ["txh", "ahi", "txr", "tls"]) {
  const notes = getDescriptor(k)!.notes;
  check(`${k}: declares notes`, Array.isArray(notes), true);
  check(`${k}: notes non-empty`, (notes?.length ?? 0) > 0, true);
  check(
    `${k}: no blank/whitespace-only note`,
    (notes ?? []).every((n) => typeof n === "string" && n.trim().length > 20),
    true,
  );
  check(
    `${k}: carries the shared per-number rate note`,
    (notes ?? []).includes(PER_NUMBER_RATE_NOTE),
    true,
  );
  // Descriptors are secret-free by contract. A note is static prose, so any
  // credential-shaped substring means someone pasted a real value in.
  check(
    `${k}: no credential-shaped substring in any note`,
    (notes ?? []).every((n) => !/(api[_-]?key\s*[:=]\s*\S|password\s*[:=]\s*\S|bearer\s+\S)/i.test(n)),
    true,
  );
}
// Every connection type the picker can offer must carry notes — otherwise the
// panel renders an empty "About this provider" for it.
check(
  "every listed connection type has notes",
  listConnectionTypes().every((t) => (t.descriptor.notes?.length ?? 0) > 0),
  true,
);

console.log(
  failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
