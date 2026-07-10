// DEV TOOL (one-off): read the prior Telnyx 10k run and emit carrier_mappings
// seed rows for migration 0095, bucketing observed raw carrier strings by
// carrier-family patterns. Confidently-bucketable mobile carriers + all voip
// carriers are mapped; the messy long tail is left to the admin unmapped queue.
// Prints SQL VALUES + a coverage report. Run:
//   npx tsx scripts/gen-carrier-seed.ts "<path to lookup_results_full_10k.csv>"
import { readFileSync, writeFileSync } from "node:fs";

// Minimal RFC4180 line parser (handles quoted fields containing commas/quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

type Bucket = "AT&T" | "T-Mobile" | "Verizon" | "Other Mobile" | "VoIP";

// Family patterns (checked in order; first match wins). Verizon/AT&T/T-Mobile
// legacy legal entities included.
const PATTERNS: Array<[RegExp, Bucket]> = [
  [/\b(verizon|cellco partnership|bell atlantic mobile)\b/i, "Verizon"],
  [/\b(at&?t|cingular|new cingular)\b/i, "AT&T"],
  [/\b(t-?mobile|metro ?pcs|omnipoint|powertel|voicestream|aerial communications|sun ?com)\b/i, "T-Mobile"],
  [/\b(boost|cricket|mint|straight talk|tracfone|google fi|u\.?s\.? ?cellular|uscc|united states cellular|gci|general communication|inland cellular|cellular south|altice mobile|keystone wireless|c ?spire|carolina west|ntelos|union telephone)\b/i, "Other Mobile"],
  [/\b(sinch|bandwidth|onvoy|twilio|telnyx|level 3|peerless|brightlink|five9|inteliquent|vitelity|thinq|8x8|ringcentral|vonage|neutral tandem|commio|voip)\b/i, "VoIP"],
];

function bucketFor(carrier: string, lineType: string): Bucket | null {
  for (const [re, b] of PATTERNS) if (re.test(carrier)) return b;
  // Any voip-line-type number with an unrecognized carrier is still a VoIP carrier.
  if (lineType === "voip") return "VoIP";
  return null; // unmapped -> admin queue
}

function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: gen-carrier-seed.ts <csv path>");
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0];
  const iLT = header.indexOf("line_type");
  const iCN = header.indexOf("carrier_name");

  // distinct carrier -> {bucket, count, lineTypes}
  const seen = new Map<string, { bucket: Bucket | null; count: number }>();
  let mobileVoipRows = 0;
  for (let k = 1; k < rows.length; k++) {
    const lt = (rows[k][iLT] ?? "").trim();
    const cn = (rows[k][iCN] ?? "").trim();
    if (!cn) continue;
    if (lt === "mobile" || lt === "voip") mobileVoipRows++;
    if (!seen.has(cn)) seen.set(cn, { bucket: bucketFor(cn, lt), count: 0 });
    seen.get(cn)!.count++;
  }

  const mapped = [...seen.entries()].filter(([, v]) => v.bucket);
  const unmapped = [...seen.entries()].filter(([, v]) => !v.bucket);
  const mappedRows = mapped.reduce((a, [, v]) => a + v.count, 0);
  const totalRows = [...seen.values()].reduce((a, v) => a + v.count, 0);

  // Emit SQL VALUES (escape single quotes). Sorted by bucket then name.
  const lines = mapped
    .sort((a, b) => a[1].bucket!.localeCompare(b[1].bucket!) || a[0].localeCompare(b[0]))
    .map(([name, v]) => `  ('${name.replace(/'/g, "''")}', '${v.bucket}', 'seed'),`);
  const sql =
    "-- Generated from the 06/25/2026 Telnyx 10k run by scripts/gen-carrier-seed.ts\n" +
    "INSERT INTO public.carrier_mappings (raw_name, carrier_norm, mapped_by) VALUES\n" +
    lines.join("\n").replace(/,$/, "") +
    "\nON CONFLICT (raw_name) DO NOTHING;\n";
  writeFileSync("scripts/_carrier_seed_generated.sql", sql);

  console.log("=== coverage ===");
  console.log(`distinct carriers: ${seen.size}  (mapped ${mapped.length}, unmapped ${unmapped.length})`);
  console.log(`rows: ${mappedRows}/${totalRows} carrier-attributed rows covered (${((mappedRows / totalRows) * 100).toFixed(1)}%)`);
  console.log(`mobile+voip rows in file: ${mobileVoipRows}`);
  const byBucket: Record<string, number> = {};
  for (const [, v] of mapped) byBucket[v.bucket!] = (byBucket[v.bucket!] ?? 0) + 1;
  console.log("mapped distinct-by-bucket:", byBucket);
  console.log("\ntop 15 UNMAPPED (count desc) -> admin queue / calibration batch:");
  unmapped.sort((a, b) => b[1].count - a[1].count).slice(0, 15)
    .forEach(([n, v]) => console.log(`  ${String(v.count).padStart(4)}  ${n}`));
  console.log(`\nwrote scripts/_carrier_seed_generated.sql (${lines.length} rows)`);
}
main();
