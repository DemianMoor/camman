// scripts/export-creative-quality.ts — one-off snapshot of creatives.quality
// before the column is dropped (ClickUp 1amdve2d47v, Part A; drop lands in P4).
//
// Read-only (withReadOnlyDb: one BEGIN READ ONLY transaction). Exports every
// row whose quality is not the default 'unknown' — the default carries no
// information, so a dropped column loses nothing for those rows.
//
//   npx tsx scripts/export-creative-quality.ts --out docs/snapshots/creatives_quality_2026-11-16.csv
import "./_env-preload";

import { hash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { withReadOnlyDb } from "./_readonly-db";

const args = process.argv.slice(2);
const OUT = args[args.indexOf("--out") + 1];

function cell(v: unknown): string {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  if (!args.includes("--out") || !OUT) throw new Error("--out <file.csv> is required");
  const rows = await withReadOnlyDb(
    (tx) => tx<Record<string, unknown>[]>`
      SELECT id, org_id, creative_id, slug, status, quality, sequence_placement, funnel_stage, created_at, text
      FROM creatives WHERE quality <> 'unknown' ORDER BY id`,
  );
  const header = ["id", "org_id", "creative_id", "slug", "status", "quality", "sequence_placement", "funnel_stage", "created_at", "text"];
  const body = [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
  writeFileSync(OUT, body);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(String(r.quality), (counts.get(String(r.quality)) ?? 0) + 1);
  console.log(`rows: ${rows.length} (${[...counts.entries()].map(([q, n]) => `${q} ${n}`).join(", ")})`);
  console.log(`sha256: ${hash("sha256", body)}`);
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
