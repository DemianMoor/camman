// scripts/apply-creative-brand-mapping.ts — P3 of ClickUp 1amdve2d47v: write the
// brands the owner chose for the creatives the P1 backfill left NULL.
//
// ⚠️ Targets whatever DATABASE_URL holds (.env.local = PRODUCTION). Owner-gated:
// --apply runs only after the owner's go, in the attended morning window (before
// 08:00 ET). The dry run is the DEFAULT and runs inside ONE `BEGIN READ ONLY`
// transaction (withReadOnlyDb).
//
// Input: the owner's filled CSV. Rows are matched by "Creative ID"; ONLY the
// "brand" column is read (a brand NAME, matched case-insensitively to the org's
// brands). Every other column is ignored.
//
// The whole run is REFUSED (nothing written) if any row fails:
//   - duplicate / non-numeric Creative ID, empty or unknown brand name
//   - the creative is not in the org
//   - the brand is not allowed on any of the creative's offers (offer_brands) —
//     the mapping never adds offer_brands rows (owner ruling 2026-11-16)
//   - the creative already holds a DIFFERENT brand (an equal one is a no-op)
// --apply additionally requires --sha256 <hex> of the CSV the owner approved,
// re-runs every check inside the write transaction, updates only rows whose
// brand_id IS NULL, and rolls back unless the updated count matches the plan and
// every CSV row reads back with its mapped brand.
//
//   npx tsx scripts/apply-creative-brand-mapping.ts --org <uuid> --csv <file>                       # dry run
//   npx tsx scripts/apply-creative-brand-mapping.ts --org <uuid> --csv <file> --apply --sha256 <hex>
//
// Afterwards: scripts/verify-creative-brand.ts --plan <P1 plan.json> --after-mapping
import "./_env-preload";

import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import postgres from "postgres";

import { toSessionModeUrl } from "@/lib/db/session-url";

import { withReadOnlyDb } from "./_readonly-db";

type Tx = postgres.TransactionSql;

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes("--apply");
const ORG = arg("--org");
const CSV = arg("--csv");
const SHA = arg("--sha256");

interface Mapping {
  creative_id: number;
  brand_name: string;
}

function readCsv(path: string): { rows: Mapping[]; sha256: string } {
  const raw = readFileSync(path);
  const sha256 = hash("sha256", raw);
  const parsed = Papa.parse<Record<string, string>>(raw.toString("utf8").replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) throw new Error(`CSV parse errors: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
  const fields = parsed.meta.fields ?? [];
  if (!fields.includes("Creative ID") || !fields.includes("brand")) {
    throw new Error(`CSV needs "Creative ID" and "brand" columns; has ${JSON.stringify(fields)}`);
  }
  const problems: string[] = [];
  const seen = new Set<number>();
  const rows: Mapping[] = [];
  parsed.data.forEach((r, i) => {
    const line = i + 2;
    const idText = (r["Creative ID"] ?? "").trim();
    const brand = (r["brand"] ?? "").trim();
    if (!/^\d+$/.test(idText)) return void problems.push(`line ${line}: Creative ID "${idText}" is not a number`);
    const id = Number(idText);
    if (seen.has(id)) return void problems.push(`line ${line}: creative ${id} appears twice`);
    seen.add(id);
    if (!brand) return void problems.push(`line ${line}: creative ${id} has no brand`);
    rows.push({ creative_id: id, brand_name: brand });
  });
  if (problems.length) throw new Error(`CSV refused:\n  ${problems.join("\n  ")}`);
  return { rows, sha256 };
}

interface PlanRow extends Mapping {
  brand_id: number;
  status: string;
  current_brand_id: number | null;
}

async function buildPlan(tx: Tx, org: string, mapping: Mapping[]) {
  const brandRows = await tx<{ id: number; name: string }[]>`
    SELECT id, name FROM brands WHERE org_id = ${org}::uuid`;
  const byName = new Map(brandRows.map((b) => [b.name.trim().toLowerCase(), b]));
  const ids = mapping.map((m) => m.creative_id);
  const creatives = await tx<{ id: number; status: string; brand_id: number | null; offer_brand_ids: number[] }[]>`
    SELECT c.id, c.status, c.brand_id,
           coalesce(array_agg(DISTINCT ob.brand_id) FILTER (WHERE ob.brand_id IS NOT NULL), '{}')::int[] AS offer_brand_ids
    FROM creatives c
    LEFT JOIN creative_offers co ON co.creative_id = c.id
    LEFT JOIN offer_brands ob ON ob.offer_id = co.offer_id
    WHERE c.org_id = ${org}::uuid AND c.id = ANY(${tx.array(ids)}::int[])
    GROUP BY c.id`;
  const byId = new Map(creatives.map((c) => [c.id, c]));

  const problems: string[] = [];
  const plan: PlanRow[] = [];
  for (const m of mapping) {
    const brand = byName.get(m.brand_name.toLowerCase());
    const c = byId.get(m.creative_id);
    if (!brand) { problems.push(`creative ${m.creative_id}: brand "${m.brand_name}" is not one of the org's brands`); continue; }
    if (!c) { problems.push(`creative ${m.creative_id}: not a creative in this org`); continue; }
    if (!c.offer_brand_ids.includes(brand.id)) {
      problems.push(`creative ${m.creative_id}: ${brand.name} is not allowed on any of its offers (offer brands: ${c.offer_brand_ids.join(", ") || "none"})`);
      continue;
    }
    if (c.brand_id != null && c.brand_id !== brand.id) {
      problems.push(`creative ${m.creative_id}: already holds brand ${c.brand_id}, mapping says ${brand.id} — not overwritten`);
      continue;
    }
    plan.push({ ...m, brand_id: brand.id, status: c.status, current_brand_id: c.brand_id });
  }
  const [{ n: unmappedNulls }] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM creatives
    WHERE org_id = ${org}::uuid AND brand_id IS NULL AND NOT (id = ANY(${tx.array(ids)}::int[]))`;
  const brandName = new Map(brandRows.map((b) => [b.id, b.name]));
  return { plan, problems, unmappedNulls, brandName };
}

function printSummary(p: Awaited<ReturnType<typeof buildPlan>>, csvRows: number, sha256: string) {
  console.log(`CSV: ${csvRows} rows · sha256 ${sha256}`);
  if (p.problems.length) {
    console.log(`\nREFUSED — ${p.problems.length} row(s) fail; nothing will be written:\n  ${p.problems.join("\n  ")}`);
    return;
  }
  const todo = p.plan.filter((r) => r.current_brand_id == null);
  const already = p.plan.length - todo.length;
  const tally = (rows: PlanRow[], key: (r: PlanRow) => string) =>
    [...rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>())]
      .map(([k, n]) => `${k} ${n}`).join(", ");
  console.log(`will set brand_id:      ${todo.length}  (${tally(todo, (r) => p.brandName.get(r.brand_id) ?? String(r.brand_id))})`);
  console.log(`                        by status: ${tally(todo, (r) => r.status)}`);
  console.log(`already hold that brand: ${already} (no-op)`);
  console.log(`creatives still NULL that the CSV does not cover: ${p.unmappedNulls}`);
}

async function main() {
  if (!ORG || !/^[0-9a-f-]{36}$/i.test(ORG)) throw new Error("--org <uuid> is required");
  if (!CSV) throw new Error("--csv <file> is required");
  const { rows, sha256 } = readCsv(CSV);
  if (APPLY && SHA !== sha256) throw new Error(`--apply needs --sha256 of the approved CSV; this file is ${sha256}`);
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x");
  console.log(`DB ${host.username.split(".").pop()} · ${APPLY ? "APPLY" : "DRY RUN (read-only)"} · org ${ORG}`);

  if (!APPLY) {
    await withReadOnlyDb(async (tx) => printSummary(await buildPlan(tx, ORG, rows), rows.length, sha256));
    return;
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const sql = postgres(toSessionModeUrl(raw), { prepare: false, max: 1, connect_timeout: 15 });
  try {
    await sql.begin(async (tx) => {
      const p = await buildPlan(tx, ORG, rows);
      printSummary(p, rows.length, sha256);
      if (p.problems.length) throw new Error("refused — rolled back");
      const todo = p.plan.filter((r) => r.current_brand_id == null);
      const updated = await tx<{ id: number }[]>`
        UPDATE creatives c SET brand_id = v.brand_id
        FROM unnest(${tx.array(todo.map((r) => r.creative_id))}::int[], ${tx.array(todo.map((r) => r.brand_id))}::int[]) AS v(id, brand_id)
        WHERE c.id = v.id AND c.org_id = ${ORG}::uuid AND c.brand_id IS NULL
        RETURNING c.id`;
      if (updated.length !== todo.length) throw new Error(`updated ${updated.length} rows, planned ${todo.length} — rolled back`);
      const back = await tx<{ id: number; brand_id: number | null }[]>`
        SELECT id, brand_id FROM creatives
        WHERE org_id = ${ORG}::uuid AND id = ANY(${tx.array(p.plan.map((r) => r.creative_id))}::int[])`;
      const got = new Map(back.map((b) => [b.id, b.brand_id]));
      const wrong = p.plan.filter((r) => got.get(r.creative_id) !== r.brand_id);
      if (wrong.length) throw new Error(`${wrong.length} rows do not read back with their mapped brand — rolled back`);
      console.log(`\nAPPLIED: ${updated.length} creatives got their mapped brand_id; ${p.plan.length} of ${p.plan.length} read back correctly.`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
