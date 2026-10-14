import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { buildLandingPageUrl } from "@/lib/landing-page-url";

// READ-ONLY. Byte-identity of landing URLs against what the OLD code actually
// minted (0211/0212 prod check, ClickUp 869fhabkw / 869fhan29).
//
// For every brand with a landing host: take stages that use a SLUG landing page,
// have no hand-edited Full URL, and have minted links. Rebuild each stage's
// destination with today's buildLandingPageUrl from the LIVE brand row
// (landing_host + landing_path), the page and the stage tracking id, and
// compare it to the destination URL stored on its links — byte for byte.
//
// Only destinations on the brand's CURRENT landing host are compared: a stage
// minted before a re-brand (e.g. campaign 1705, created under Guide Kin) points
// at the old brand's host by design and is reported, not failed. A later slug
// edit on the page is also expected to differ, and is reported as such.
//
// Works before 0211 too (landing_path read as 'lp' when the column is absent —
// printed), so it can be dry-run tonight and run for real after the migration.

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

async function main() {
  const col = (await db.execute(sql`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'brands' AND column_name = 'landing_path'
  `)) as unknown as { n: number }[];
  if (col[0].n === 0) console.log("NOTE: brands.landing_path absent (pre-0211) — reading it as 'lp'.\n");

  const rows = (await db.execute(sql`
    SELECT b.id AS brand_id, b.name, lower(b.landing_host) AS host,
           coalesce(to_jsonb(b) ->> 'landing_path', 'lp') AS path,
           s.id AS stage_id, s.tracking_id, lp.id AS page_id, lp.slug, lp.status, lp.updated_at,
           d.url, d.created_at AS dest_created
    FROM brands b
    JOIN campaigns c ON c.brand_id = b.id AND c.org_id = b.org_id
    JOIN campaign_stages s ON s.campaign_id = c.id
    JOIN offer_landing_pages lp ON lp.id = s.landing_page_id AND lp.kind = 'slug'
    JOIN LATERAL (
      SELECT DISTINCT ld.url, min(ld.created_at) AS created_at
      FROM links l JOIN link_destinations ld ON ld.id = l.destination_id
      WHERE l.stage_id = s.id
      GROUP BY ld.url
    ) d ON true
    WHERE b.landing_host IS NOT NULL
      AND coalesce(trim(s.full_url), '') = ''
    ORDER BY b.id, s.id
  `)) as unknown as {
    brand_id: number; name: string; host: string; path: string; stage_id: number; tracking_id: string;
    page_id: number; slug: string; status: string; updated_at: string; url: string; dest_created: string;
  }[];

  const byBrand = new Map<number, typeof rows>();
  for (const r of rows) byBrand.set(r.brand_id, [...(byBrand.get(r.brand_id) ?? []), r]);

  for (const [brandId, list] of byBrand) {
    const { name, host, path } = list[0];
    let same = 0;
    let otherHost = 0;
    let slugEdited = 0;
    const diffs: string[] = [];
    for (const r of list) {
      const destHost = (r.url.match(/^https?:\/\/([^/?#]+)/)?.[1] ?? "").toLowerCase();
      if (destHost !== host) {
        otherHost++;
        continue;
      }
      const built = buildLandingPageUrl({
        page: { id: r.page_id, kind: "slug", slug: r.slug, external_url: null, status: "active" },
        landingHost: host,
        landingPath: path,
        trackingId: r.tracking_id,
      });
      if (built.ok && built.url === r.url) same++;
      else if (!r.url.includes(`/${r.slug}?`) && !r.url.endsWith(`/${r.slug}`)) slugEdited++;
      else diffs.push(`stage ${r.stage_id}: stored ${r.url} ≠ built ${built.ok ? built.url : built.reason}`);
    }
    console.log(`brand ${brandId} ${name} (${host}/${path}/): ${list.length} stage-destinations — ` +
      `${same} byte-identical, ${otherHost} on another host (pre-rebrand), ${slugEdited} slug edited since mint, ${diffs.length} DIFFERENT`);
    check(`brand ${brandId}: zero unexplained differences`, diffs.length === 0, diffs.slice(0, 5).join("\n        "));
    if (same === 0 && otherHost < list.length) check(`brand ${brandId}: at least one byte-identical comparison`, false);
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
