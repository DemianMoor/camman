// Verify offer ↔ brand assignment (migration 0194, card 869f94t0t).
//
// Three modes, each prints its scope and FAILS on an empty one:
//
//   --db    READ-ONLY. Safe on prod and preview.
//           (1) backfill: per org, rows written by the migration's transaction
//               == offers × brands that existed at that moment;
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

// ── --db ─────────────────────────────────────────────────────────────────────
async function dbMode() {
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    console.log(`DB host: ${host}`);

    // The backfill rows share one created_at: the migration transaction's now().
    const backfill = await sql<
      {
        org_id: string;
        t: Date;
        actual: number;
        offers: number;
        brands: number;
      }[]
    >`
      WITH t AS (
        SELECT org_id, min(created_at) AS t FROM offer_brands GROUP BY org_id
      )
      SELECT t.org_id, t.t,
        (SELECT count(*)::int FROM offer_brands ob
          WHERE ob.org_id = t.org_id AND ob.created_at = t.t) AS actual,
        (SELECT count(*)::int FROM offers o
          WHERE o.org_id = t.org_id AND o.created_at <= t.t) AS offers,
        (SELECT count(*)::int FROM brands b
          WHERE b.org_id = t.org_id AND b.created_at <= t.t) AS brands
      FROM t ORDER BY t.org_id`;
    const orgsWithBoth = await sql<{ n: number }[]>`
      SELECT count(DISTINCT o.org_id)::int AS n
      FROM offers o JOIN brands b ON b.org_id = o.org_id`;
    check(
      "backfill scope non-empty",
      backfill.length > 0,
      `${backfill.length} org(s) with offer_brands rows; ${orgsWithBoth[0].n} org(s) have offers and brands`,
    );
    check(
      "every org with offers and brands was backfilled",
      backfill.length === orgsWithBoth[0].n,
    );
    for (const r of backfill) {
      check(
        `backfill org ${r.org_id} at ${r.t.toISOString()}`,
        r.actual === r.offers * r.brands,
        `${r.actual} rows = ${r.offers} offers × ${r.brands} brands (${r.offers * r.brands})`,
      );
    }

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
    check(
      "zero in-scope campaigns outside their brand",
      outOfBrand.length === 0,
      `${withPair.length} with a brand+offer pair; out of brand: ${
        outOfBrand.map((r) => r.id).join(", ") || "none"
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
