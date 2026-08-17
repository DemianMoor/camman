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
// txh2 is an ALIAS (a second TextHub account modeled as its own provider row).
check("getDescriptor('txh2') resolves", getDescriptor("txh2")?.displayName, "TextHub");
check("getDescriptor('txh') resolves", getDescriptor("txh")?.displayName, "TextHub");
check("getDescriptor('nope') is null", getDescriptor("nope"), null);
// ...but must NOT appear as its own pickable connection type.
const types = listConnectionTypes();
check(
  "listConnectionTypes excludes the txh2 alias",
  types.map((t) => t.key).sort(),
  ["ahi", "tls", "txh", "txr"],
);
check("TextHub appears exactly once", types.filter((t) => t.descriptor.displayName === "TextHub").length, 1);
check(
  "every adapter in the registry declares a descriptor",
  ["txh", "txh2", "ahi", "txr", "tls"].filter((k) => !getAdapter(k).descriptor),
  [],
);

console.log("\n── can_validate honesty ──");
const byKey = Object.fromEntries(types.map((t) => [t.key, t.canValidate]));
check("txh can validate (inbox read)", byKey.txh, true);
check("ahi can validate (CDR read)", byKey.ahi, true);
check("txr can validate (dashboards read)", byKey.txr, true);
// Tells has exactly one endpoint and it SENDS — no honest non-sending check.
check("tls canNOT validate (send-only API)", byKey.tls, false);

console.log("\n── Seams declared-but-unset (no speculative values) ──");
for (const k of ["txh", "ahi", "txr", "tls"]) {
  const d = getDescriptor(k)!;
  check(`${k}: defaultOptOutFooter unset`, d.defaultOptOutFooter, undefined);
  check(`${k}: appendsOwnOptOut unset`, d.appendsOwnOptOut, undefined);
  check(`${k}: phoneSettingFields unset`, d.phoneSettingFields, undefined);
}

console.log(
  failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
