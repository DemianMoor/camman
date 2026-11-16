// scripts/backfill-creative-brand.ts — assign creatives.brand_id (migration
// 0240, ClickUp 1amdve2d47v P1) from send history and offer brands.
//
// ⚠️ Targets whatever DATABASE_URL holds (.env.local = PRODUCTION). Owner-gated:
// --apply runs only after the owner's go, in the attended morning window (before
// 08:00 ET). The dry run is the DEFAULT and runs inside ONE `BEGIN READ ONLY`
// transaction (withReadOnlyDb) — it writes nothing, not even to the DB session.
//
// Rules (owner, 2026-11-16):
//   (a) used before        → brand of its LATEST use: the most recent sent
//       message (max stage_sends.sent_at, status 'sent') across every stage that
//       holds the creative; a manual-mode stage with no stage_sends rows counts at
//       campaign_stages.sent_at. Brand = that stage's campaign's brand.
//       ⚠️ ONLY when that brand is allowed on at least one of the creative's
//       offers (offer_brands). Otherwise → NOT assigned, exported with the
//       latest-use brand as a suggestion.
//   (b) never used, the union of brands across ALL its offers is exactly 1
//       → that brand.
//   (c) never used, 2+ brands → NOT assigned, exported.
//   Anything else (no offer / offer with no brand / uses with no brand / an exact
//   latest-use tie) → NOT assigned, exported with the reason.
//
// Exported rows stay NULL; the owner fills the "brand" column of the .xlsx and a
// later step (P3) applies it. --apply writes ONLY rows whose brand_id IS NULL, so
// it is idempotent and never overwrites a brand someone already set.
//
// Cost: the latest-use ranking aggregates stage_sends only for creatives used
// under 2+ brands (~1,361 stages / ~2.6M sent rows on 2026-11-16). A creative
// used under one brand needs no timestamps — its brand is the same whichever
// send is latest.
//
//   npx tsx scripts/backfill-creative-brand.ts --org <uuid> --out <dir>                  # dry run
//   npx tsx scripts/backfill-creative-brand.ts --org <uuid> --out <dir> --compare-links  # + links check (reads ~1.5 GB: quiet window only)
//   npx tsx scripts/backfill-creative-brand.ts --org <uuid> --out <dir> --apply
//
// Outputs in --out: plan.csv (every creative, its bucket and target),
// export.csv (the rows the owner maps; converted to .xlsx for the owner) and
// plan.json (the same plan + the campaign_stages checksum, read by
// scripts/verify-creative-brand.ts).
import "./_env-preload";

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
const COMPARE_LINKS = args.includes("--compare-links");
const ORG = arg("--org");
const OUT = arg("--out");

type Bucket = "a" | "b" | "export";

interface PlanRow {
  creative_id: number;
  status: string;
  text: string;
  current_brand_id: number | null;
  bucket: Bucket;
  reason: string;
  target_brand_id: number | null;
  suggested_brand_id: number | null; // latest-use brand, when used
  used_brand_ids: number[];
  offer_ids: number[];
  offer_names: string[];
  offer_brand_ids: number[];
  latest_use_at: string | null;
}

interface Plan {
  rows: PlanRow[];
  brands: Map<number, string>;
  usedStages: number;
  multiBrandCreatives: number;
  multiBrandStages: number;
  aggregateMs: number;
  stageChecksum: string;
}

async function hasBrandColumn(tx: Tx): Promise<boolean> {
  const r = await tx`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'creatives' AND column_name = 'brand_id'`;
  return r.length > 0;
}

async function stageChecksum(tx: Tx, org: string): Promise<string> {
  const r = await tx<{ c: string | null; n: number }[]>`
    SELECT md5(string_agg(id::text || ':' || coalesce(creative_id::text, ''), ',' ORDER BY id)) AS c,
           count(*)::int AS n
    FROM campaign_stages WHERE org_id = ${org}::uuid`;
  return `${r[0].n} stages / md5 ${r[0].c}`;
}

async function buildPlan(tx: Tx, org: string): Promise<Plan> {
  await tx`SET LOCAL statement_timeout = '300s'`;
  const withCol = await hasBrandColumn(tx);

  const brandRows = await tx<{ id: number; name: string }[]>`
    SELECT id, name FROM brands WHERE org_id = ${org}::uuid`;
  const brands = new Map(brandRows.map((b) => [b.id, b.name]));

  const creatives = withCol
    ? await tx<{ id: number; status: string; text: string; brand_id: number | null }[]>`
        SELECT id, status, text, brand_id FROM creatives WHERE org_id = ${org}::uuid ORDER BY id`
    : await tx<{ id: number; status: string; text: string; brand_id: number | null }[]>`
        SELECT id, status, text, NULL::int AS brand_id FROM creatives WHERE org_id = ${org}::uuid ORDER BY id`;

  type OfferRow = { creative_id: number; offer_id: number; name: string | null; brand_ids: number[] };
  const offerRows = await tx<OfferRow[]>`
    SELECT co.creative_id, co.offer_id, o.name,
           coalesce(array_agg(ob.brand_id ORDER BY ob.brand_id)
                    FILTER (WHERE ob.brand_id IS NOT NULL), '{}') AS brand_ids
    FROM creative_offers co
    JOIN offers o ON o.id = co.offer_id
    LEFT JOIN offer_brands ob ON ob.offer_id = co.offer_id
    WHERE co.org_id = ${org}::uuid
    GROUP BY co.creative_id, co.offer_id, o.name
    ORDER BY co.creative_id, co.offer_id`;
  const offersBy = new Map<number, OfferRow[]>();
  for (const o of offerRows) {
    const list = offersBy.get(o.creative_id) ?? [];
    list.push(o);
    offersBy.set(o.creative_id, list);
  }

  // A stage counts as a USE when it has a sent message, or (manual mode) a
  // stamped sent_at. EXISTS short-circuits on stage_sends_stage_id_idx.
  const stages = await tx<
    {
      stage_id: number;
      creative_id: number;
      brand_id: number | null;
      sent_at: Date | null;
      has_api_sent: boolean;
    }[]
  >`
    SELECT cs.id AS stage_id, cs.creative_id, c.brand_id, cs.sent_at,
           EXISTS (SELECT 1 FROM stage_sends ss
                   WHERE ss.stage_id = cs.id AND ss.status = 'sent') AS has_api_sent
    FROM campaign_stages cs
    JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${org}::uuid AND cs.creative_id IS NOT NULL`;
  const used = stages.filter((s) => s.has_api_sent || s.sent_at != null);
  const usesBy = new Map<number, typeof used>();
  for (const s of used) {
    const list = usesBy.get(s.creative_id) ?? [];
    list.push(s);
    usesBy.set(s.creative_id, list);
  }

  // Exact per-message ranking, only where the brand is in question.
  const multi = [...usesBy.entries()].filter(
    ([, list]) => new Set(list.filter((s) => s.brand_id != null).map((s) => s.brand_id)).size > 1,
  );
  const multiStageIds = multi.flatMap(([, list]) => list.filter((s) => s.has_api_sent).map((s) => s.stage_id));
  const t0 = Date.now();
  const lastSent = new Map<number, Date>();
  if (multiStageIds.length > 0) {
    const agg = await tx<{ stage_id: number; last_sent: Date }[]>`
      SELECT stage_id, max(sent_at) AS last_sent
      FROM stage_sends
      WHERE stage_id = ANY(${tx.array(multiStageIds)}::int[])
        AND org_id = ${org}::uuid AND status = 'sent' AND sent_at IS NOT NULL
      GROUP BY stage_id`;
    for (const a of agg) lastSent.set(a.stage_id, a.last_sent);
  }
  const aggregateMs = Date.now() - t0;

  const rows: PlanRow[] = creatives.map((cr) => {
    const offers = offersBy.get(cr.id) ?? [];
    const offerBrandIds = [...new Set(offers.flatMap((o) => o.brand_ids))].sort((x, y) => x - y);
    const uses = usesBy.get(cr.id) ?? [];
    const usedBrandIds = [...new Set(uses.map((s) => s.brand_id).filter((b): b is number => b != null))].sort(
      (x, y) => x - y,
    );
    const base = {
      creative_id: cr.id,
      status: cr.status,
      text: cr.text,
      current_brand_id: cr.brand_id,
      used_brand_ids: usedBrandIds,
      offer_ids: offers.map((o) => o.offer_id),
      offer_names: offers.map((o) => o.name ?? ""),
      offer_brand_ids: offerBrandIds,
    };
    const exported = (reason: string, suggested: number | null, at: Date | null): PlanRow => ({
      ...base,
      bucket: "export",
      reason,
      target_brand_id: null,
      suggested_brand_id: suggested,
      latest_use_at: at ? at.toISOString() : null,
    });

    if (uses.length > 0) {
      if (usedBrandIds.length === 0) return exported("used, but no use has a campaign brand", null, null);
      // Latest use per brand. Single-brand: no ranking needed.
      let latest: { brand: number; at: Date | null } | null = null;
      let tie = false;
      if (usedBrandIds.length === 1) {
        const at = uses.reduce<Date | null>((m, s) => (s.sent_at && (!m || s.sent_at > m) ? s.sent_at : m), null);
        latest = { brand: usedBrandIds[0], at };
      } else {
        const perBrand = new Map<number, Date>();
        for (const s of uses) {
          if (s.brand_id == null) continue;
          const at = s.has_api_sent ? (lastSent.get(s.stage_id) ?? s.sent_at) : s.sent_at;
          if (!at) continue;
          const prev = perBrand.get(s.brand_id);
          if (!prev || at > prev) perBrand.set(s.brand_id, at);
        }
        const ranked = [...perBrand.entries()].sort((x, y) => y[1].getTime() - x[1].getTime());
        if (ranked.length === 0) return exported("used, but no use has a timestamp", null, null);
        latest = { brand: ranked[0][0], at: ranked[0][1] };
        tie = ranked.length > 1 && ranked[1][1].getTime() === ranked[0][1].getTime();
      }
      if (tie) return exported("latest use is an exact tie between brands", latest.brand, latest.at);
      if (!offerBrandIds.includes(latest.brand)) {
        return exported(
          "latest-use brand is not allowed on any of the creative's offers",
          latest.brand,
          latest.at,
        );
      }
      return {
        ...base,
        bucket: "a",
        reason: usedBrandIds.length > 1 ? "used under 2+ brands; latest use wins" : "used under one brand",
        target_brand_id: latest.brand,
        suggested_brand_id: latest.brand,
        latest_use_at: latest.at ? latest.at.toISOString() : null,
      };
    }

    if (offers.length === 0) return exported("never used; no offer", null, null);
    if (offerBrandIds.length === 0) return exported("never used; its offer(s) have no brand", null, null);
    if (offerBrandIds.length > 1) {
      return exported(`never used; its offer(s) have ${offerBrandIds.length} brands`, null, null);
    }
    return {
      ...base,
      bucket: "b",
      reason: offers.length > 1 ? "never used; all its offers share one brand" : "never used; offer has one brand",
      target_brand_id: offerBrandIds[0],
      suggested_brand_id: null,
      latest_use_at: null,
    };
  });

  return {
    rows,
    brands,
    usedStages: used.length,
    multiBrandCreatives: multi.length,
    multiBrandStages: multi.reduce((n, [, l]) => n + l.length, 0),
    aggregateMs,
    stageChecksum: await stageChecksum(tx, org),
  };
}

// ── links cross-check (owner Q6) ────────────────────────────────────────────
// "Latest use" above follows each stage's CURRENT creative_id, but a regular
// stage's creative can be swapped after it sent. links.creative_id is stamped
// per message at mint time, so it records what actually went out. One grouped
// pass over links (~1.5 GB on 2026-11-16 ⇒ quiet window only).
async function compareLinks(tx: Tx, org: string, plan: Plan) {
  await tx`SET LOCAL statement_timeout = '900s'`;
  const t0 = Date.now();
  const groups = await tx<{ stage_id: number; creative_id: number; last_at: Date; n: number }[]>`
    SELECT stage_id, creative_id, max(created_at) AS last_at, count(*)::int AS n
    FROM links
    WHERE org_id = ${org}::uuid AND creative_id IS NOT NULL AND stage_id IS NOT NULL
    GROUP BY stage_id, creative_id`;
  const ms = Date.now() - t0;
  const stageInfo = await tx<{ id: number; creative_id: number | null; brand_id: number | null }[]>`
    SELECT cs.id, cs.creative_id, c.brand_id
    FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${org}::uuid`;
  const stageBy = new Map(stageInfo.map((s) => [s.id, s]));

  const swappedPairs = groups.filter((g) => stageBy.get(g.stage_id)?.creative_id !== g.creative_id);
  const latestByLinks = new Map<number, { brand: number | null; at: Date }>();
  for (const g of groups) {
    const prev = latestByLinks.get(g.creative_id);
    if (!prev || g.last_at > prev.at) {
      latestByLinks.set(g.creative_id, { brand: stageBy.get(g.stage_id)?.brand_id ?? null, at: g.last_at });
    }
  }

  const diffs: string[] = [];
  let compared = 0;
  let linksOnly = 0;
  let bucketChanges = 0;
  for (const r of plan.rows) {
    const l = latestByLinks.get(r.creative_id);
    if (!l) continue;
    if (r.suggested_brand_id == null) {
      linksOnly++;
      diffs.push(`${r.creative_id},links-only,,${l.brand ?? ""},${r.bucket}`);
      continue;
    }
    compared++;
    if (l.brand !== r.suggested_brand_id) {
      // What the links-based rule would assign: its brand if allowed on an offer, else nothing.
      const linksTarget = l.brand != null && r.offer_brand_ids.includes(l.brand) ? l.brand : null;
      if (linksTarget !== r.target_brand_id) bucketChanges++;
      diffs.push(`${r.creative_id},differs,${r.suggested_brand_id},${l.brand ?? ""},${r.bucket}`);
    }
  }
  const differ = diffs.filter((d) => d.includes(",differs,")).length;
  console.log(`\nlinks cross-check (one grouped pass over links: ${ms.toLocaleString()} ms)`);
  console.log(`  (stage, creative) groups in links:            ${groups.length.toLocaleString()}`);
  console.log(`  groups whose creative ≠ the stage's current:  ${swappedPairs.length.toLocaleString()}` +
    ` (${new Set(swappedPairs.map((g) => g.stage_id)).size} stages, ${new Set(swappedPairs.map((g) => g.creative_id)).size} creatives)`);
  console.log(`  creatives compared (used by both sources):    ${compared.toLocaleString()}`);
  console.log(`  ⭐ creatives whose links-based latest brand differs from the stage-based one: ${differ}`);
  console.log(`  creatives with links but no stage-based use:  ${linksOnly}`);
  console.log(`  of the differing, ones whose assignment would change: ${bucketChanges}`);
  if (OUT) {
    writeFileSync(
      resolve(OUT, "links-diff.csv"),
      ["creative_id,kind,stage_based_brand_id,links_based_brand_id,bucket", ...diffs].join("\n") + "\n",
    );
    console.log(`  wrote ${resolve(OUT, "links-diff.csv")}`);
  }
}

// ── output ──────────────────────────────────────────────────────────────────
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

function writeOutputs(plan: Plan, out: string) {
  mkdirSync(out, { recursive: true });
  const name = (id: number | null) => (id == null ? "" : `${plan.brands.get(id) ?? "?"} (${id})`);
  const names = (ids: number[]) => ids.map((i) => name(i)).join("; ");
  writeFileSync(
    resolve(out, "plan.csv"),
    csv(
      ["creative_id", "status", "bucket", "reason", "target_brand", "suggested_brand_latest_use", "latest_use_at",
        "used_brands", "offer_ids", "offer_brands", "current_brand_id"],
      plan.rows.map((r) => [r.creative_id, r.status, r.bucket, r.reason, name(r.target_brand_id),
        name(r.suggested_brand_id), r.latest_use_at ?? "", names(r.used_brand_ids), r.offer_ids.join("; "),
        names(r.offer_brand_ids), r.current_brand_id ?? ""]),
    ),
  );
  writeFileSync(
    resolve(out, "export.csv"),
    csv(
      ["creative_id", "status", "creative_text", "offer_id", "offer_name", "offer_brands",
        "suggested_brand_latest_use", "why_in_file", "brand"],
      plan.rows
        .filter((r) => r.bucket === "export")
        .map((r) => [r.creative_id, r.status, r.text, r.offer_ids.join("; "), r.offer_names.join("; "),
          names(r.offer_brand_ids), name(r.suggested_brand_id), r.reason, ""]),
    ),
  );
  // Machine-readable twin for scripts/verify-creative-brand.ts.
  writeFileSync(
    resolve(out, "plan.json"),
    JSON.stringify(
      {
        org: ORG,
        mode: APPLY ? "apply" : "dry-run",
        snapshot: new Date().toISOString(),
        stage_checksum: plan.stageChecksum,
        rows: plan.rows.map((r) => ({
          creative_id: r.creative_id,
          bucket: r.bucket,
          target_brand_id: r.target_brand_id,
          suggested_brand_id: r.suggested_brand_id,
          current_brand_id: r.current_brand_id,
        })),
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`\nwrote ${resolve(out, "plan.csv")}\nwrote ${resolve(out, "export.csv")}\nwrote ${resolve(out, "plan.json")}`);
}

function printSummary(plan: Plan, org: string) {
  const by = (b: Bucket) => plan.rows.filter((r) => r.bucket === b);
  const a = by("a");
  const b = by("b");
  const ex = by("export");
  const reasons = new Map<string, number>();
  for (const r of ex) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  const perBrand = (rows: PlanRow[]) =>
    [...plan.brands.keys()]
      .map((id) => `${plan.brands.get(id)} ${rows.filter((r) => r.target_brand_id === id).length}`)
      .join(", ");
  const st = (rows: PlanRow[]) =>
    `${rows.filter((r) => r.status === "active").length} active / ${rows.filter((r) => r.status !== "active").length} archived`;

  console.log(`\nscope: org ${org} · ${plan.rows.length.toLocaleString()} creatives · ${plan.brands.size} brands · snapshot ${new Date().toISOString()}`);
  console.log(`       ${plan.usedStages.toLocaleString()} used stages · ${plan.multiBrandCreatives} creatives used under 2+ brands` +
    ` (${plan.multiBrandStages.toLocaleString()} stages ranked per message, stage_sends aggregate ${plan.aggregateMs.toLocaleString()} ms)`);
  console.log(`       campaign_stages checksum: ${plan.stageChecksum}`);
  console.log(`(a) used → latest-use brand:          ${a.length.toString().padStart(5)}  (${st(a)}; ${perBrand(a)})`);
  console.log(`(b) never used, one offer brand:      ${b.length.toString().padStart(5)}  (${st(b)}; ${perBrand(b)})`);
  console.log(`not assigned → export.csv:            ${ex.length.toString().padStart(5)}  (${st(ex)})`);
  for (const [reason, n] of [...reasons.entries()].sort()) console.log(`      ${n.toString().padStart(5)}  ${reason}`);
  const already = plan.rows.filter((r) => r.current_brand_id != null);
  if (already.length > 0) {
    console.log(`already have a brand_id (left untouched): ${already.length}` +
      ` (${already.filter((r) => r.target_brand_id != null && r.target_brand_id !== r.current_brand_id).length} differ from the plan)`);
  }
  const total = a.length + b.length + ex.length;
  if (total !== plan.rows.length) throw new Error(`bucket sum ${total} ≠ ${plan.rows.length} creatives`);
}

async function main() {
  if (!ORG || !/^[0-9a-f-]{36}$/i.test(ORG)) throw new Error("--org <uuid> is required");
  if (!OUT) throw new Error("--out <dir> is required (plan.csv / export.csv land there)");
  if (APPLY && COMPARE_LINKS) throw new Error("--compare-links is read-only; run it without --apply");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x");
  console.log(`DB ${host.username.split(".").pop()} · ${APPLY ? "APPLY" : "DRY RUN (read-only)"} · org ${ORG}`);

  if (!APPLY) {
    await withReadOnlyDb(async (tx) => {
      const plan = await buildPlan(tx, ORG);
      printSummary(plan, ORG);
      writeOutputs(plan, OUT);
      if (COMPARE_LINKS) await compareLinks(tx, ORG, plan);
    });
    return;
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const sql = postgres(toSessionModeUrl(raw), { prepare: false, max: 1, connect_timeout: 15 });
  try {
    await sql.begin(async (tx) => {
      if (!(await hasBrandColumn(tx))) throw new Error("creatives.brand_id does not exist — apply migration 0240 first");
      const plan = await buildPlan(tx, ORG);
      printSummary(plan, ORG);
      writeOutputs(plan, OUT);
      const todo = plan.rows.filter((r) => r.target_brand_id != null && r.current_brand_id == null);
      const ids = todo.map((r) => r.creative_id);
      const brandIds = todo.map((r) => r.target_brand_id as number);
      const updated = await tx<{ id: number }[]>`
        UPDATE creatives c SET brand_id = v.brand_id
        FROM unnest(${tx.array(ids)}::int[], ${tx.array(brandIds)}::int[]) AS v(id, brand_id)
        WHERE c.id = v.id AND c.org_id = ${ORG}::uuid AND c.brand_id IS NULL
        RETURNING c.id`;
      if (updated.length !== todo.length) {
        throw new Error(`updated ${updated.length} rows, planned ${todo.length} — rolled back`);
      }
      const after = await stageChecksum(tx, ORG);
      if (after !== plan.stageChecksum) {
        throw new Error(`campaign_stages changed inside the backfill transaction (${plan.stageChecksum} → ${after}) — rolled back`);
      }
      console.log(`\nAPPLIED: ${updated.length} creatives got a brand_id; campaign_stages unchanged (${after}).`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
