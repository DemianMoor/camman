import { extractPassthrough, passthroughNamesError } from "@/lib/intake/passthrough";

// Pure-function test for partner passthrough extraction. No DB.

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
}

// P1 case-insensitive key match, numbers stringified
check("P1 match + stringify",
  extractPassthrough({ List_ID: 123, relay_lead_id: "abc" }, ["list_id", "relay_lead_id"]),
  { data: { list_id: "123", relay_lead_id: "abc" }, warnings: [] });
check("P1b padded key matches", extractPassthrough({ " list_id ": "x" }, ["list_id"]),
  { data: { list_id: "x" }, warnings: [] });

// P2 unknown extras ignored
check("P2 unknown ignored", extractPassthrough({ reference_id: "x" }, []), { data: null, warnings: [] });

// P3 null / "" / absent
check("P3 null/empty/absent omitted",
  extractPassthrough({ a: null, b: "" }, ["a", "b", "c"]), { data: null, warnings: [] });
check("P3b first non-empty match wins",
  extractPassthrough({ "LIST_ID": "", list_id: "second" }, ["list_id"]),
  { data: { list_id: "second" }, warnings: [] });

// P4 object / array
check("P4 object value",
  extractPassthrough({ list_id: { a: 1 } }, ["list_id"]),
  { data: null, warnings: ["list_id: value must be a string, number or boolean"] });
check("P4 array value",
  extractPassthrough({ list_id: [1] }, ["list_id"]),
  { data: null, warnings: ["list_id: value must be a string, number or boolean"] });

// P5 length
check("P5 257 chars omitted",
  extractPassthrough({ list_id: "a".repeat(257) }, ["list_id"]),
  { data: null, warnings: ["list_id: value longer than 256 characters"] });
check("P5 256 chars kept",
  extractPassthrough({ list_id: "a".repeat(256) }, ["list_id"]).data?.list_id.length, 256);

// P6 total bytes
{
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const raw: Record<string, string> = {};
  for (const n of names) raw[n] = "x".repeat(250);
  const r = extractPassthrough(raw, names);
  const kept = Object.keys(r.data ?? {});
  check("P6 kept in whitelist order", kept, ["a", "b", "c", "d", "e", "f", "g"]);
  check("P6 dropped warns", r.warnings, ["h: dropped, partner data over 2048 bytes", "i: dropped, partner data over 2048 bytes"]);
  check("P6 under limit", Buffer.byteLength(JSON.stringify(r.data)) <= 2048, true);
}

// P7 scalars
check("P7 true/0",
  extractPassthrough({ a: true, b: 0 }, ["a", "b"]),
  { data: { a: "true", b: "0" }, warnings: [] });

// P8 names validation
const ten = Array.from({ length: 11 }, (_, i) => `f${i}`);
check("P8 11 names", passthroughNamesError(ten), "At most 10 passthrough fields");
check("P8 uppercase invalid", typeof passthroughNamesError(["List"]), "string");
check("P8 zip built-in", passthroughNamesError(["zip"]), "zip is already a built-in field");
check("P8 zip_code built-in", passthroughNamesError(["zip_code"]), "zip_code is already a built-in field");
check("P8 payout reserved", passthroughNamesError(["payout"]), "payout is a reserved placeholder name");
check("P8 duplicates", typeof passthroughNamesError(["list_id", "list_id"]), "string");
check("P8 valid", passthroughNamesError(["list_id", "relay_lead_id"]), null);

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed");
