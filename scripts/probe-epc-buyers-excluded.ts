import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// READ-ONLY. BLOCKING CHECK for the EPC-unification build (Decision 3):
// do any converted recipients (buyers) sit OUTSIDE the merged denominator?
// A buyer in the numerator but not the denominator is a broken metric.
//
//   B1 buyers vs the row-1 set (Keitaro saw the landing visit, CamMan excluded)
//   B2 buyers with NO human click at all — the full integrity question, wider
//      than row 1, measured at BOTH dedup grains the build will use:
//        own-link grain  (stage / creative rows)
//        campaign grain  (campaign rows: any human click by that contact)
//   B3 revenue attached to each bucket
//
// Run: npx tsx scripts/probe-epc-buyers-excluded.ts

const BASE = (process.env.KEITARO_API_URL ?? "https://admin.gdkn.org").replace(/\/+$/, "");
const KEY = process.env.KEITARO_API_KEY?.trim() ?? "";
const VISIT_CAMPAIGN = "gk-lp-visits";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_DAY = "2026-06-03";
const LAST_DAY = "2026-08-11";

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : r[k] == null ? "" : String(r[k]));

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function landingIds(day: string): Promise<string[]> {
  const res = await fetch(`${BASE}/admin_api/v1/clicks/log`, {
    method: "POST",
    headers: { "Api-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      range: { from: `${day} 00:00:00`, to: `${day} 23:59:59`, timezone: "America/New_York" },
      columns: ["sub_id_1", "campaign"],
      filters: [{ name: "sub_id_1", operator: "NOT_EQUAL", expression: "" }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return [];
  const j = (await res.json().catch(() => null)) as { rows?: Row[] } | null;
  const rows = Array.isArray(j?.rows) ? j!.rows! : [];
  return rows
    .filter((r) => str(r, "campaign").toLowerCase() === VISIT_CAMPAIGN)
    .map((r) => str(r, "sub_id_1"))
    .filter((s) => UUID_RE.test(s));
}

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const q = async <T>(query: ReturnType<typeof sql>) => {
    let out: T[] = [];
    await d.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
      out = (await tx.execute(query)) as unknown as T[];
    });
    return out;
  };

  // ── B2/B3 ─ integrity at both grains, DB-only ─────────────────────────────
  console.log("\n=== B2 buyers vs the merged denominator, by dedup grain ===");
  const grains = await q<Record<string, string>>(sql`
    WITH conv AS (
      SELECT ss.id, ss.campaign_id, ss.contact_id, ss.link_id,
             coalesce(ss.sale_revenue, 0) AS revenue
      FROM stage_sends ss WHERE ss.converted_at IS NOT NULL
    ),
    own AS (
      SELECT conv.id,
             count(cl.id) AS taps,
             bool_or(cl.classification = 'human') AS own_human
      FROM conv LEFT JOIN clicks cl ON cl.link_id = conv.link_id
      GROUP BY conv.id
    ),
    camp AS (
      SELECT conv.id,
             bool_or(cl.classification = 'human') AS campaign_human
      FROM conv
      LEFT JOIN links l ON l.campaign_id = conv.campaign_id AND l.contact_id = conv.contact_id
      LEFT JOIN clicks cl ON cl.link_id = l.id
      GROUP BY conv.id
    )
    SELECT CASE
             WHEN own.taps = 0 THEN 'NO CamMan click at all'
             WHEN own.own_human THEN 'in denominator at BOTH grains'
             WHEN camp.campaign_human THEN 'in campaign grain ONLY (stage/creative row excludes)'
             ELSE 'EXCLUDED at every grain (buyer, no human click)'
           END AS bucket,
           count(*)::text AS buyers,
           sum(conv.revenue)::numeric(12,2) AS revenue
    FROM conv JOIN own ON own.id = conv.id JOIN camp ON camp.id = conv.id
    GROUP BY 1 ORDER BY 2 DESC
  `);
  console.table(grains);

  // ── B1 ─ intersect buyers with the row-1 set (needs the Keitaro id set) ───
  const all = new Set<string>();
  for (const day of days(FIRST_DAY, LAST_DAY)) for (const id of await landingIds(day)) all.add(id);
  console.log(`\n=== B1 row-1 intersection (Keitaro landing recipients pulled: ${all.size}) ===`);

  const ids = [...all];
  const CHUNK = 5000;
  const acc = new Map<string, { buyers: number; revenue: number }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const idList = sql.join(ids.slice(i, i + CHUNK).map((id) => sql`(${id}::uuid)`), sql`, `);
    const rows = await q<{ bucket: string; buyers: string; revenue: string }>(sql`
      WITH k(id) AS (VALUES ${idList}),
      conv AS (
        SELECT ss.id, ss.link_id, coalesce(ss.sale_revenue, 0) AS revenue
        FROM stage_sends ss WHERE ss.converted_at IS NOT NULL
      ),
      hit AS (
        SELECT conv.id, conv.revenue,
               bool_or(cl.classification = 'human') AS own_human
        FROM conv JOIN k ON k.id = conv.id
        LEFT JOIN clicks cl ON cl.link_id = conv.link_id
        GROUP BY conv.id, conv.revenue
      )
      SELECT CASE WHEN own_human THEN 'buyer, Keitaro visit, CamMan human (fine)'
                  ELSE 'BUYER INSIDE ROW-1 EXCLUSION' END AS bucket,
             count(*)::text AS buyers,
             sum(revenue)::numeric(12,2) AS revenue
      FROM hit GROUP BY 1
    `);
    for (const r of rows) {
      const cur = acc.get(r.bucket) ?? { buyers: 0, revenue: 0 };
      cur.buyers += Number(r.buyers);
      cur.revenue += Number(r.revenue);
      acc.set(r.bucket, cur);
    }
  }
  console.table([...acc.entries()].map(([bucket, v]) => ({ bucket, buyers: v.buyers, revenue: v.revenue.toFixed(2) })));

  // Context: total buyers + revenue, for share math.
  console.log("\n=== B3 totals for share math ===");
  console.table(
    await q(sql`
      SELECT count(*)::text AS converted_recipients,
             sum(coalesce(sale_revenue, 0))::numeric(12,2) AS attributed_revenue,
             (SELECT sum(revenue)::numeric(12,2) FROM keitaro_stage_results) AS all_time_revenue
      FROM stage_sends WHERE converted_at IS NOT NULL
    `),
  );

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
