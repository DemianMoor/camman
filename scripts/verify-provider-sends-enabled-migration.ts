// R1 guard — migration 0138 landed correctly AND changed nothing.
//
// Two independent claims, both of which must hold:
//
//   1. STRUCTURE. `sms_providers.sends_enabled` exists as boolean NOT NULL
//      DEFAULT true, and `opt_out_footer` as nullable text.
//   2. INERTNESS. Every provider row reads sends_enabled = true and
//      opt_out_footer IS NULL, and no send-path source file references either
//      column yet. R1 ships the columns; R2 ships the behaviour. If this script
//      passes while a reader already exists, the "byte-identical" claim on the
//      R1 deploy is false.
//
// Guard-grade per docs/07-conventions.md: prints its full input scope (every
// provider row by name, and the file list it scanned), refuses to pass on an
// empty scope, and fails loudly rather than defaulting.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

// Source files that decide whether a send happens. R1 must leave every one of
// them untouched by the new columns. Listed explicitly (not globbed) so a file
// disappearing is a hard error below rather than a silently smaller scan.
const SEND_PATH_FILES = [
  "lib/sends/kickoff.ts",
  "lib/sends/drain.ts",
  "lib/sends/scheduled.ts",
  "lib/sends/preflight.ts",
  "lib/sends/send-state.ts",
  "lib/sends/stall-detector.ts",
  "lib/sends/circuit-breakers.ts",
];

async function main() {
  // ── 1. Structure ──────────────────────────────────────────────────────────
  const cols = (await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sms_providers'
      AND column_name IN ('sends_enabled', 'opt_out_footer')
    ORDER BY column_name
  `)) as unknown as {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }[];

  console.log(`\nColumn scope: ${cols.length} of 2 expected columns found`);
  for (const c of cols) {
    console.log(
      `     ${c.column_name}: ${c.data_type} ` +
        `${c.is_nullable === "NO" ? "NOT NULL" : "NULL"} default=${c.column_default ?? "(none)"}`,
    );
  }
  check("both 0138 columns exist", cols.length === 2, `found ${cols.length}`);

  const se = cols.find((c) => c.column_name === "sends_enabled");
  check(
    "sends_enabled is boolean NOT NULL DEFAULT true",
    se?.data_type === "boolean" &&
      se?.is_nullable === "NO" &&
      (se?.column_default ?? "").includes("true"),
    `got type=${se?.data_type} nullable=${se?.is_nullable} default=${se?.column_default}`,
  );

  const of = cols.find((c) => c.column_name === "opt_out_footer");
  check(
    "opt_out_footer is nullable text with no default",
    of?.data_type === "text" && of?.is_nullable === "YES" && of?.column_default == null,
    `got type=${of?.data_type} nullable=${of?.is_nullable} default=${of?.column_default}`,
  );

  // ── 2. Inertness: data ────────────────────────────────────────────────────
  const rows = (await db.execute(sql`
    SELECT id, sms_provider_id, adapter_code, name, status,
           supports_api_send, send_paused, sends_enabled, opt_out_footer
    FROM sms_providers ORDER BY id
  `)) as unknown as {
    id: number;
    sms_provider_id: string;
    adapter_code: string | null;
    name: string;
    status: string;
    supports_api_send: boolean;
    send_paused: boolean;
    sends_enabled: boolean;
    opt_out_footer: string | null;
  }[];

  console.log(`\nProvider scope: ${rows.length} rows`);
  for (const r of rows) {
    console.log(
      `     #${r.id} ${r.sms_provider_id} (adapter=${r.adapter_code ?? "NULL"}, ${r.status}) ` +
        `api_send=${r.supports_api_send} paused=${r.send_paused} ` +
        `sends_enabled=${r.sends_enabled} opt_out_footer=${r.opt_out_footer ?? "NULL"}`,
    );
  }

  // Non-empty before equal: an empty table would satisfy "every row is true".
  check("provider scope is non-empty", rows.length > 0, `${rows.length} rows`);

  const notEnabled = rows.filter((r) => r.sends_enabled !== true);
  check(
    "every provider row has sends_enabled = true (behaviour unchanged)",
    rows.length > 0 && notEnabled.length === 0,
    notEnabled.length
      ? `off on: ${notEnabled.map((r) => `#${r.id} ${r.sms_provider_id}`).join(", ")}`
      : `all ${rows.length} rows enabled`,
  );

  const withFooter = rows.filter((r) => r.opt_out_footer != null);
  check(
    "every provider row has opt_out_footer IS NULL (STOP text unchanged)",
    withFooter.length === 0,
    withFooter.length
      ? `set on: ${withFooter.map((r) => `#${r.id} ${r.sms_provider_id}`).join(", ")}`
      : `all ${rows.length} rows NULL`,
  );

  // ── 3. Inertness: source ──────────────────────────────────────────────────
  // A missing file is an ERROR, never a skipped check — a renamed send-path
  // module must fail here rather than quietly shrink the scan.
  //
  // ⚠️ `sends_enabled` is an AMBIGUOUS token: org_settings has a column of the
  // same name and the send path legitimately reads it all over (the two-switch
  // gate). A bare /\bsends_enabled\b/ therefore matches 9 pre-existing, correct
  // lines and would fail this check on an untouched tree. The assertion keys on
  // PROVIDER-QUALIFIED forms only. The org-level hits are counted and printed
  // rather than silently filtered, so the reader can see what was excluded.
  const PROVIDER_QUALIFIED = [
    /\bp\.sends_enabled\b/,
    /\bsms_providers\.sends_enabled\b/,
    /\bprovider\.sends_enabled\b/,
    /provider_sends_disabled/,
    /\bopt_out_footer\b/, // unambiguous — org_settings has no such column
  ];
  const repoRoot = process.cwd();
  let scanned = 0;
  const readers: string[] = [];
  let orgLevelHits = 0;
  for (const rel of SEND_PATH_FILES) {
    const abs = path.join(repoRoot, rel);
    let src: string;
    try {
      src = await fs.readFile(abs, "utf8");
    } catch {
      check(`send-path file present: ${rel}`, false, "file not found — scan scope is wrong");
      continue;
    }
    scanned++;
    orgLevelHits += (src.match(/\bsends_enabled\b/g) ?? []).length;
    const hit = PROVIDER_QUALIFIED.filter((re) => re.test(src));
    if (hit.length) readers.push(`${rel} [${hit.map((r) => r.source).join(", ")}]`);
  }
  console.log(`\nSource scope: scanned ${scanned} of ${SEND_PATH_FILES.length} send-path files`);
  console.log(
    `     ${orgLevelHits} bare 'sends_enabled' occurrence(s) across them — expected, and all` +
      ` org_settings (the two-switch gate). Not what this check asserts on.`,
  );
  check(
    "every listed send-path file was readable",
    scanned === SEND_PATH_FILES.length,
    `${scanned}/${SEND_PATH_FILES.length}`,
  );
  check(
    "no send-path file reads the PROVIDER 0138 columns yet (R1 is inert)",
    readers.length === 0,
    readers.length ? `referenced in: ${readers.join(" | ")}` : "none reference them",
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
