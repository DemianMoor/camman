// One-shot, idempotent repair of malformed guidekn destination URLs.
//
// A string-concatenation bug wrote malformed guidekn destinations into
// link_destinations (tracking id glued into the path, empty sub_id3, or an
// unsubstituted `subid3=sub_id3` placeholder). This rewrites each such row — and
// the owning stage's full_url — to the canonical shape derived from the stage's
// OWN tracking_id:
//     https://www.guidekn.com/lp/<slug>?sub_id3=<stage.tracking_id>
// url_hash is recomputed to match (same SHA-256 as lib/links/mint-link.ts).
//
// Dry-run by default (prints the before/after diff, writes nothing). Pass
// `--apply` to commit inside a single transaction. Idempotent — a second run
// finds zero malformed rows. Non-guidekn destinations are never touched.
//
// SAFETY: a stage that is actively materializing (status='pending' with no
// materialized_at) is skipped and reported — never rewrite a destination
// mid-send. Run this BEFORE applying migration 0094.
//
// Run: npx tsx scripts/backfill-guidekn-destinations.ts          (dry run)
//      npx tsx scripts/backfill-guidekn-destinations.ts --apply  (commit)

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createHash } from "node:crypto";

import postgres from "postgres";

const CANONICAL_RE = /^https:\/\/www\.guidekn\.com\/lp\/[a-z]+\?sub_id3=[A-Za-z0-9_]+$/;
const SLUG_RE = /https:\/\/www\.guidekn\.com\/lp\/([a-z]+)/;

// Byte-for-byte the same hash mint-link.ts uses for link_destinations.url_hash.
function hashUrl(url: string): string {
  return createHash("sha256").update(url.trim(), "utf-8").digest("hex");
}

interface Row {
  dest_id: number;
  org_id: string;
  dest_url: string;
  stage_id: number;
  status: string;
  tracking_id: string | null;
  full_url: string | null;
  materialized_at: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  // Stages to leave completely untouched (both their destination row and
  // full_url), e.g. rows under manual review. Usage: --skip=516,517
  const skipArg = process.argv.find((a) => a.startsWith("--skip="));
  const skipStageIds = new Set(
    (skipArg?.slice("--skip=".length) ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n)),
  );
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }
  const sql = postgres(dbUrl, { prepare: false, max: 1 });

  try {
    // Narrow to guidekn /lp/ destinations in SQL, then filter to the malformed
    // ones in JS with the SAME regex the app uses (CANONICAL_RE) — doing the
    // shape check in JS avoids Postgres-regex backslash-escaping pitfalls inside
    // a postgres-js tagged template.
    const allGuidekn = (await sql`
      SELECT ld.id            AS dest_id,
             ld.org_id        AS org_id,
             ld.url           AS dest_url,
             cs.id            AS stage_id,
             cs.status        AS status,
             cs.tracking_id   AS tracking_id,
             cs.full_url      AS full_url,
             cs.materialized_at AS materialized_at
      FROM link_destinations ld
      JOIN links l ON l.destination_id = ld.id
      JOIN campaign_stages cs ON cs.id = l.stage_id
      WHERE ld.url LIKE '%guidekn.com/lp/%'
      GROUP BY ld.id, ld.org_id, ld.url, cs.id, cs.status, cs.tracking_id,
               cs.full_url, cs.materialized_at
      ORDER BY cs.id
    `) as unknown as Row[];
    const rows = allGuidekn.filter((r) => !CANONICAL_RE.test(r.dest_url.trim()));

    if (rows.length === 0) {
      console.log("No malformed guidekn destinations found — nothing to do. ✓");
      return;
    }

    console.log(`Found ${rows.length} malformed guidekn destination(s).\n`);
    let planned = 0;
    let skipped = 0;
    const updates: { dest_id: number; stage_id: number; org_id: string; canonical: string; hash: string; fixFullUrl: boolean }[] = [];

    for (const r of rows) {
      if (skipStageIds.has(r.stage_id)) {
        console.log(`  ⏭ SKIP stage ${r.stage_id}: excluded via --skip (left untouched by request)`);
        skipped++;
        continue;
      }
      const midSend = r.status === "pending" && r.materialized_at === null;
      const slug = SLUG_RE.exec(r.dest_url)?.[1] ?? null;
      const tid = r.tracking_id;

      if (!slug || !tid) {
        console.log(`  ⚠ SKIP stage ${r.stage_id}: cannot derive ${!slug ? "slug" : "tracking_id"} — fix by hand`);
        skipped++;
        continue;
      }
      if (midSend) {
        console.log(`  ⚠ SKIP stage ${r.stage_id}: actively materializing (pending, no materialized_at) — not touched mid-send`);
        skipped++;
        continue;
      }

      const canonical = `https://www.guidekn.com/lp/${slug}?sub_id3=${tid}`;
      if (!CANONICAL_RE.test(canonical)) {
        console.log(`  ⚠ SKIP stage ${r.stage_id}: derived URL is not canonical (${canonical}) — fix by hand`);
        skipped++;
        continue;
      }

      // Collision guard: another dest in the same org already holding the
      // canonical url_hash would break the (org_id, url_hash) unique index.
      const hash = hashUrl(canonical);
      const clash = (await sql`
        SELECT id FROM link_destinations
        WHERE org_id = ${r.org_id} AND url_hash = ${hash} AND id <> ${r.dest_id}
        LIMIT 1
      `) as unknown as { id: number }[];
      if (clash[0]) {
        console.log(`  ⚠ SKIP stage ${r.stage_id}: canonical URL already exists as dest ${clash[0].id} — re-point links by hand`);
        skipped++;
        continue;
      }

      const fixFullUrl = (r.full_url ?? "") !== canonical;
      console.log(`  stage ${r.stage_id} [${r.status}] dest ${r.dest_id}`);
      console.log(`      dest.url:  ${r.dest_url}`);
      console.log(`             →   ${canonical}`);
      if (fixFullUrl) {
        console.log(`      full_url:  ${r.full_url ?? "(null)"}`);
        console.log(`             →   ${canonical}`);
      } else {
        console.log(`      full_url:  already canonical ✓`);
      }
      updates.push({ dest_id: r.dest_id, stage_id: r.stage_id, org_id: r.org_id, canonical, hash, fixFullUrl });
      planned++;
    }

    console.log(`\nPlanned: ${planned}   Skipped: ${skipped}`);

    if (!apply) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
      return;
    }
    if (planned === 0) {
      console.log("\nNothing to apply.");
      return;
    }

    await sql.begin(async (tx) => {
      for (const u of updates) {
        await tx`
          UPDATE link_destinations
          SET url = ${u.canonical}, url_hash = ${u.hash}
          WHERE id = ${u.dest_id} AND org_id = ${u.org_id}
        `;
        if (u.fixFullUrl) {
          await tx`
            UPDATE campaign_stages
            SET full_url = ${u.canonical}
            WHERE id = ${u.stage_id} AND org_id = ${u.org_id}
          `;
        }
      }
    });

    console.log(`\nApplied ${planned} repair(s). ✓`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
