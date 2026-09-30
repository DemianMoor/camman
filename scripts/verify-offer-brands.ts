// Verify offer ↔ brand assignment (migration 0194, card 869f94t0t).
//
// Three modes, each prints its scope and FAILS on an empty one:
//
//   --db    READ-ONLY. Safe on prod and preview.
//           (1) assignments vs the owner-confirmed baseline (BASELINE below);
//               the one-time backfill check passed 2026-09-29 and is retired;
//           (2) scope: every active / paused / completed-with-pending-stages
//               campaign has its (brand, offer) pair assigned — zero
//               out-of-brand on day one.
//   --http  MOVED to scripts/verify-offer-brands-http.ts. It writes, so it must
//           import the preview-DB guard unconditionally — which refuses any
//           non-preview target and would have broken the read-only --db run
//           against production. Splitting by what each mode DOES is what let
//           both satisfy the guard without an exclusion entry.
//           A throwaway user + its signup-trigger org, then through the real
//           API: picker subset per brand, new brand starts empty, a
//           grandfathered campaign saves unchanged, a CHANGED unassigned pair
//           is rejected, duplicate copies an out-of-brand pair. Deletes the
//           user + org it created, by id.
//   --diff  Zero changes on send-path files vs origin/main.
//
// db:    npx tsx scripts/verify-offer-brands.ts --db                (prod: .env.local)
//        npx tsx --env-file=C:/AFF/camman/.env.demo scripts/verify-offer-brands.ts --db
// http:  BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//        npx tsx --env-file=C:/AFF/camman/.env.demo scripts/verify-offer-brands.ts --http
// diff:  npx tsx scripts/verify-offer-brands.ts --diff
import "./_env-preload";

import { execSync } from "node:child_process";

import postgres from "postgres";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── The expected assignments: an OWNER-CONFIRMED BASELINE, not the backfill ──
//
// Until 2026-09-30 this checked that the migration's backfill rows still
// equalled offers × brands (147 = 49 × 3). That was true on day one (verified
// 2026-09-29) and could only ever go red afterwards: the offer form REPLACES an
// offer's whole brand set on save, so every curation deletes backfill rows. On
// 2026-09-30 the owner curated 24 offers (15:23–15:27 UTC, plus offer 60) —
// "that was me, deliberate" — and the old check reported 72 missing rows.
//
// The expectation is now the owner-confirmed state at BASELINE_AT (52 offers,
// 103 pairs). Against it, per offer:
//   same set                                  → ok
//   different set, and EVERY current row was  → reported: a save through the
//     written after BASELINE_AT                  app (replace-all), i.e. curation
//   different set WITHOUT that full rewrite    → FAIL: rows removed some other
//                                                way (cascade, manual SQL, a bug)
//   offer gone                                 → reported (an offer delete
//                                                cascades by design)
// Re-baseline deliberately (owner-confirmed), never to make a red run green.
const BASELINE_AT = new Date("2026-09-30T20:14:32Z");
const BASELINE_ORG = "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";
const BASELINE: Record<number, number[]> = {
  1: [8, 142, 143],
  2: [8, 142, 143],
  3: [8, 142, 143],
  4: [8, 142, 143],
  5: [8, 142, 143],
  6: [8, 142, 143],
  58: [8],
  59: [8],
  60: [8],
  61: [142],
  62: [8],
  75: [142],
  76: [8, 142, 143],
  77: [8],
  78: [8, 142, 143],
  79: [8],
  80: [8],
  81: [8, 142, 143],
  82: [8, 142, 143],
  83: [8, 142, 143],
  96: [8],
  97: [8, 142, 143],
  98: [8, 142, 143],
  99: [8, 142, 143],
  100: [8, 143],
  101: [8, 142, 143],
  112: [8, 142, 143],
  113: [8, 142, 143],
  114: [8, 142, 143],
  115: [142],
  116: [8, 142, 143],
  117: [8, 142, 143],
  118: [8],
  121: [8, 142, 143],
  122: [143],
  123: [143],
  124: [143],
  126: [8],
  127: [8, 142, 143],
  130: [8, 142, 143],
  131: [8],
  132: [8, 142, 143],
  133: [143],
  134: [142],
  135: [8, 142, 143],
  136: [143],
  137: [8],
  138: [142],
  139: [143],
  140: [143],
  141: [143],
  142: [8],
};
// Campaigns whose (brand, offer) pair is outside the brand BECAUSE of that
// curation: grandfathered by design (the save check fires only when the pair
// changes; nothing on the send path reads offer_brands). Reviewed 2026-09-30:
// 1044/1045 paused with no open stages, 1154/1355 completed with a stranded
// past "pending" stage. A campaign NOT listed here going out of brand fails.
const ACKNOWLEDGED_OUT_OF_BRAND = new Set([1044, 1045, 1154, 1355]);

// ── --db ─────────────────────────────────────────────────────────────────────
async function dbMode() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    console.log(`DB host: ${host}`);

    const rows = await sql<
      { offer_id: number; brand_id: number; created_at: Date }[]
    >`
      SELECT offer_id, brand_id, created_at FROM offer_brands
      WHERE org_id = ${BASELINE_ORG}::uuid`;
    const current = new Map<number, { brands: number[]; oldest: Date }>();
    for (const r of rows) {
      const c = current.get(r.offer_id) ?? { brands: [], oldest: r.created_at };
      c.brands.push(r.brand_id);
      if (r.created_at < c.oldest) c.oldest = r.created_at;
      current.set(r.offer_id, c);
    }
    const offersNow = new Set(
      (
        await sql<{ id: number }[]>`
          SELECT id FROM offers WHERE org_id = ${BASELINE_ORG}::uuid`
      ).map((r) => r.id),
    );
    const key = (xs: number[]) => [...xs].sort((a, b) => a - b).join(",");
    const baselineIds = Object.keys(BASELINE).map(Number);
    check(
      "baseline scope non-empty",
      baselineIds.length > 0 && rows.length > 0,
      `${baselineIds.length} offers in the baseline of ${BASELINE_AT.toISOString()}; ${rows.length} rows now`,
    );
    const resaved: string[] = [];
    const gone: number[] = [];
    const unexplained: string[] = [];
    for (const id of baselineIds) {
      const now = current.get(id);
      if (!offersNow.has(id)) {
        gone.push(id);
        continue;
      }
      const was = key(BASELINE[id]);
      const is = now ? key(now.brands) : "";
      if (was === is) continue;
      if (now && now.oldest > BASELINE_AT)
        resaved.push(`${id} [${was}]→[${is}] at ${now.oldest.toISOString()}`);
      else unexplained.push(`${id} [${was}]→[${is || "none"}]`);
    }
    const added = [...current.keys()].filter((id) => !(id in BASELINE));
    console.log(
      `  re-saved since the baseline: ${resaved.join("; ") || "none"}
` +
        `  offers deleted since: ${gone.join(", ") || "none"}
` +
        `  offers created since: ${added.join(", ") || "none"}`,
    );
    check(
      "every change since the baseline came through a save (replace-all)",
      unexplained.length === 0,
      unexplained.join("; ") || "none unexplained",
    );

    const scope = await sql<
      {
        id: number;
        status: string;
        brand_id: number | null;
        offer_id: number | null;
        assigned: boolean;
      }[]
    >`
      SELECT c.id, c.status, c.brand_id, c.offer_id,
        EXISTS (
          SELECT 1 FROM offer_brands ob
          WHERE ob.org_id = c.org_id AND ob.offer_id = c.offer_id
            AND ob.brand_id = c.brand_id
        ) AS assigned
      FROM campaigns c
      WHERE c.status IN ('active', 'paused')
         OR (c.status = 'completed' AND EXISTS (
              SELECT 1 FROM campaign_stages s
              WHERE s.campaign_id = c.id AND s.status IN ('scheduled', 'pending')))
      ORDER BY c.id`;
    const byStatus = new Map<string, number>();
    for (const r of scope)
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    check(
      "campaign scope non-empty",
      scope.length > 0,
      `${scope.length} campaigns: ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(", ")}`,
    );
    const withPair = scope.filter(
      (r) => r.brand_id != null && r.offer_id != null,
    );
    const outOfBrand = withPair.filter((r) => !r.assigned);
    const fresh = outOfBrand.filter(
      (r) => !ACKNOWLEDGED_OUT_OF_BRAND.has(r.id),
    );
    check(
      "no in-scope campaign outside its brand beyond the acknowledged ones",
      fresh.length === 0,
      `${withPair.length} with a brand+offer pair; out of brand: ${
        outOfBrand
          .map((r) => `${r.id}${ACKNOWLEDGED_OUT_OF_BRAND.has(r.id) ? " (acknowledged)" : " NEW"}`)
          .join(", ") || "none"
      }`,
    );
  } finally {
    await sql.end();
  }
}

// ── --diff ───────────────────────────────────────────────────────────────────
const SEND_PATH = [
  "lib/sends/",
  "lib/drip/",
  "lib/reporting/",
  "lib/audience-snapshot.ts",
  "lib/segment-rules-eval.ts",
  "lib/engagement/",
  "lib/links/",
  "app/api/cron/",
  "app/api/campaigns/[campaignId]/status/",
  "app/api/campaigns/[campaignId]/stages/",
  "app/api/campaigns/[campaignId]/send",
  "app/r/",
];
function diffMode() {
  const changed = execSync("git diff --name-only origin/main...HEAD", {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  check(
    "branch diff non-empty",
    changed.length > 0,
    `${changed.length} files vs origin/main`,
  );
  console.log(`send-path prefixes checked: ${SEND_PATH.join(", ")}`);
  const hits = changed.filter((f) => SEND_PATH.some((p) => f.startsWith(p)));
  check(
    "zero send-path files changed",
    hits.length === 0,
    hits.join(", ") || "none",
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--db") await dbMode();
  else if (mode === "--diff") diffMode();
  else if (mode === "--http") {
    // Split out on 2026-09-30 so this file issues no writes and can satisfy the
    // preview-DB guard while still being runnable read-only against production.
    console.error(
      "--http moved to scripts/verify-offer-brands-http.ts (it writes, and imports the preview-DB guard).",
    );
    process.exit(1);
  } else {
    console.error("usage: verify-offer-brands.ts --db | --diff");
    process.exit(1);
  }
  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
