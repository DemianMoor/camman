// scripts/verify-creative-brand.ts — verifies the creatives.brand_id backfill
// (migration 0240, ClickUp 1amdve2d47v). Read-only: one BEGIN READ ONLY
// transaction via withReadOnlyDb.
//
// Run IMMEDIATELY after `backfill-creative-brand.ts --apply`, against the
// plan.json that run wrote. Later sends can legitimately move a creative's
// "latest use"; this checks the backfill, not tomorrow's world.
//
// What it asserts (each line prints PASS/FAIL with its counts):
//   S  scope — org, creatives, brands, plan snapshot; an empty scope is a FAIL
//   1  every creative in the org is in the plan, and the plan's buckets sum up
//   2  INDEPENDENT recompute: a pure-SQL implementation of the rule (not the
//      backfill's TypeScript) lands on the same target for every creative
//   3  bucket (a)/(b) rows hold exactly their planned brand
//   4  export rows are still NULL (or, with --after-mapping, hold a brand)
//   5  every non-NULL brand_id is a brand of the same org
//   6  campaign_stages (id, creative_id) checksum equals the plan's — the
//      backfill touched no stage
//   7  live stages whose creative's brand ≠ their campaign's brand: REPORTED
//      (expected, they keep sending — rule 4), not failed
//   8  source bar: the send path never reads creatives.brand_id
//   9  with --expect-no-nulls (P4 gate): zero creatives with brand_id NULL
//
// The recompute (2) aggregates stage_sends for creatives used under 2+ brands
// (~1.1 GB on 2026-11-16) — run it in the quiet window, like the backfill.
//
//   npx tsx scripts/verify-creative-brand.ts --plan <dir>/plan.json [--after-mapping] [--expect-no-nulls]
import "./_env-preload";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { withReadOnlyDb } from "./_readonly-db";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PLAN_PATH = arg("--plan");
const AFTER_MAPPING = args.includes("--after-mapping");
const EXPECT_NO_NULLS = args.includes("--expect-no-nulls");

// Every file on the send path that joins creatives (kickoff, preflight, drain,
// drip scheduling, link minting, tag rules). A brand check here would
// re-validate already-saved stages at send time, which rule 4 forbids.
const SEND_PATH_FILES = [
  "lib/sends/kickoff.ts",
  "lib/sends/preflight.ts",
  "lib/sends/preflight-breakdown.ts",
  "lib/sends/send-preflight.ts",
  "lib/sends/scheduled.ts",
  "lib/sends/eligibility.ts",
  "lib/sends/recipients.ts",
  "lib/sends/tag-rules.ts",
  "lib/drip/scheduler.ts",
  "lib/drip/hourly-room.ts",
  "lib/drip/followups.ts",
  "lib/links/mint-link.ts",
];
const BRAND_READ = /\b(?:cr|creatives)\.brand_id\b|creatives\s*\.\s*brand_id/;

interface PlanFile {
  org: string;
  mode: string;
  snapshot: string;
  stage_checksum: string;
  rows: { creative_id: number; bucket: "a" | "b" | "export"; target_brand_id: number | null }[];
}

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

async function main() {
  if (!PLAN_PATH || !existsSync(PLAN_PATH)) throw new Error("--plan <path to plan.json> is required");
  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8")) as PlanFile;
  const org = plan.org;
  const planBy = new Map(plan.rows.map((r) => [r.creative_id, r]));

  await withReadOnlyDb(async (tx) => {
    await tx`SET LOCAL statement_timeout = '300s'`;
    const col = await tx`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'creatives' AND column_name = 'brand_id'`;
    if (col.length === 0) throw new Error("creatives.brand_id does not exist — migration 0240 is not applied");

    const creatives = await tx<{ id: number; brand_id: number | null; brand_org: string | null }[]>`
      SELECT cr.id, cr.brand_id, b.org_id::text AS brand_org
      FROM creatives cr LEFT JOIN brands b ON b.id = cr.brand_id
      WHERE cr.org_id = ${org}::uuid ORDER BY cr.id`;
    const brands = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM brands WHERE org_id = ${org}::uuid`;

    // S — scope
    console.log(`scope: org ${org} · ${creatives.length} creatives · ${brands[0].n} brands · plan ${plan.mode} @ ${plan.snapshot} (${plan.rows.length} rows)`);
    console.log(`       now ${new Date().toISOString()} · plan file ${resolve(PLAN_PATH)}`);
    check("S scope non-empty", creatives.length > 0 && plan.rows.length > 0 && brands[0].n > 0,
      `${creatives.length} creatives, ${plan.rows.length} plan rows, ${brands[0].n} brands`);

    // 1 — coverage
    const missing = creatives.filter((c) => !planBy.has(c.id));
    const extra = plan.rows.filter((r) => !creatives.some((c) => c.id === r.creative_id));
    const n = (b: string) => plan.rows.filter((r) => r.bucket === b).length;
    check("1 plan covers every creative", missing.length === 0 && extra.length === 0,
      `a ${n("a")} + b ${n("b")} + export ${n("export")} = ${plan.rows.length}; ` +
      `${missing.length} creatives not in plan${missing.length ? ` (created after it? ids ${missing.slice(0, 10).map((m) => m.id).join(",")})` : ""}, ${extra.length} plan rows gone`);

    // 2 — independent recompute of the rule, in SQL.
    const expected = await tx<{ id: number; expected: number | null }[]>`
      WITH st AS MATERIALIZED (
        SELECT cs.id, cs.creative_id, c.brand_id, cs.sent_at,
               EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = cs.id AND ss.status = 'sent') AS has_api
        FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.org_id = ${org}::uuid AND cs.creative_id IS NOT NULL
      ), u AS MATERIALIZED (
        SELECT * FROM st WHERE has_api OR sent_at IS NOT NULL
      ), mb AS (
        SELECT creative_id FROM u WHERE brand_id IS NOT NULL
        GROUP BY creative_id HAVING count(DISTINCT brand_id) > 1
      ), agg AS (
        SELECT stage_id, max(sent_at) AS last_api FROM stage_sends
        WHERE stage_id IN (SELECT id FROM u WHERE has_api AND creative_id IN (SELECT creative_id FROM mb))
          AND org_id = ${org}::uuid AND status = 'sent' AND sent_at IS NOT NULL
        GROUP BY stage_id
      ), lu AS (
        SELECT u.creative_id, u.brand_id,
               CASE WHEN u.has_api THEN coalesce(a.last_api, u.sent_at) ELSE u.sent_at END AS at
        FROM u LEFT JOIN agg a ON a.stage_id = u.id
        WHERE u.brand_id IS NOT NULL
      ), pb AS (
        SELECT creative_id, brand_id, max(at) AS at FROM lu GROUP BY creative_id, brand_id
      ), rk AS (
        SELECT creative_id, brand_id,
               rank() OVER (PARTITION BY creative_id ORDER BY at DESC NULLS LAST) AS r
        FROM pb
      ), top AS (
        -- n_top > 1 ⇔ an exact tie between brands (⇒ not assigned)
        SELECT creative_id, min(brand_id) AS brand_id, count(*) AS n_top
        FROM rk WHERE r = 1 GROUP BY creative_id
      ), ob AS (
        SELECT co.creative_id,
               coalesce(array_agg(DISTINCT obr.brand_id) FILTER (WHERE obr.brand_id IS NOT NULL), '{}') AS brands
        FROM creative_offers co LEFT JOIN offer_brands obr ON obr.offer_id = co.offer_id
        WHERE co.org_id = ${org}::uuid GROUP BY co.creative_id
      )
      SELECT cr.id,
        CASE
          WHEN t.creative_id IS NOT NULL THEN
            CASE WHEN t.n_top = 1 AND t.brand_id = ANY (coalesce(ob.brands, '{}')) THEN t.brand_id END
          WHEN EXISTS (SELECT 1 FROM u WHERE u.creative_id = cr.id) THEN NULL
          WHEN cardinality(coalesce(ob.brands, '{}')) = 1 THEN ob.brands[1]
        END AS expected
      FROM creatives cr
      LEFT JOIN top t ON t.creative_id = cr.id
      LEFT JOIN ob ON ob.creative_id = cr.id
      WHERE cr.org_id = ${org}::uuid`;
    const disagree = expected.filter((e) => planBy.has(e.id) && (planBy.get(e.id)!.target_brand_id ?? null) !== (e.expected ?? null));
    check("2 SQL recompute == backfill plan", disagree.length === 0,
      `${expected.length} creatives recomputed, ${disagree.length} disagree` +
      (disagree.length ? ` (e.g. ${disagree.slice(0, 5).map((d) => `${d.id}: plan ${planBy.get(d.id)!.target_brand_id} vs sql ${d.expected}`).join("; ")})` : ""));

    // 3 / 4 — the stored values
    const actual = new Map(creatives.map((c) => [c.id, c.brand_id]));
    const assigned = plan.rows.filter((r) => r.bucket !== "export");
    const wrong = assigned.filter((r) => actual.get(r.creative_id) !== r.target_brand_id);
    check("3 (a)/(b) rows hold their planned brand", wrong.length === 0,
      `${assigned.length} checked, ${wrong.length} wrong${wrong.length ? ` (ids ${wrong.slice(0, 10).map((w) => w.creative_id).join(",")})` : ""}`);
    const exportRows = plan.rows.filter((r) => r.bucket === "export");
    const exportSet = exportRows.filter((r) => actual.get(r.creative_id) != null);
    check(
      AFTER_MAPPING ? "4 export rows mapped by the owner" : "4 export rows still NULL",
      AFTER_MAPPING ? exportSet.length === exportRows.length : exportSet.length === 0,
      `${exportRows.length} export rows, ${exportSet.length} hold a brand`,
    );

    // 5 — same-org brands only
    const crossOrg = creatives.filter((c) => c.brand_id != null && c.brand_org !== org);
    check("5 brand_id belongs to the same org", crossOrg.length === 0,
      `${creatives.filter((c) => c.brand_id != null).length} non-NULL, ${crossOrg.length} cross-org`);

    // 6 — stages untouched
    const cs = await tx<{ c: string | null; n: number }[]>`
      SELECT md5(string_agg(id::text || ':' || coalesce(creative_id::text, ''), ',' ORDER BY id)) AS c,
             count(*)::int AS n
      FROM campaign_stages WHERE org_id = ${org}::uuid`;
    const now = `${cs[0].n} stages / md5 ${cs[0].c}`;
    check("6 campaign_stages unchanged since the plan", now === plan.stage_checksum,
      now === plan.stage_checksum ? now : `plan ${plan.stage_checksum} → now ${now} (a stage was created or edited in between — check before blaming the backfill)`);

    // 7 — live cross-brand stages: report only
    const live = await tx<{ campaign_id: number; stages: number }[]>`
      SELECT c.id AS campaign_id, count(*)::int AS stages
      FROM campaign_stages s
      JOIN campaigns c ON c.id = s.campaign_id
      JOIN creatives cr ON cr.id = s.creative_id
      WHERE s.org_id = ${org}::uuid AND s.archived_at IS NULL AND c.archived_at IS NULL
        AND c.status IN ('draft', 'active', 'paused', 'scheduled')
        AND cr.brand_id IS NOT NULL AND c.brand_id IS NOT NULL AND cr.brand_id <> c.brand_id
      GROUP BY c.id ORDER BY c.id`;
    console.log(`INFO  7 live stages whose creative's brand ≠ campaign brand (they keep sending): ` +
      `${live.reduce((s, l) => s + l.stages, 0)} stages in ${live.length} campaigns` +
      (live.length ? ` (${live.map((l) => `campaign ${l.campaign_id}: ${l.stages}`).join(", ")})` : ""));

    // 9 — P4 gate
    if (EXPECT_NO_NULLS) {
      const nulls = creatives.filter((c) => c.brand_id == null).length;
      check("9 zero creatives without a brand (P4 gate)", nulls === 0, `${nulls} NULL`);
    }
  });

  // 8 — source bar
  const absent = SEND_PATH_FILES.filter((f) => !existsSync(resolve(process.cwd(), f)));
  const readers = SEND_PATH_FILES.filter((f) => !absent.includes(f) && BRAND_READ.test(readFileSync(resolve(process.cwd(), f), "utf8")));
  check("8 send path never reads creatives.brand_id", absent.length === 0 && readers.length === 0,
    `${SEND_PATH_FILES.length} files scanned (${SEND_PATH_FILES.join(", ")})` +
    (absent.length ? `; MISSING: ${absent.join(", ")}` : "") + (readers.length ? `; READS IT: ${readers.join(", ")}` : ""));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
