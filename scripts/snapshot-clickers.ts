import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";

// READ-ONLY. Pre-backfill snapshot of `clickers`, taken before the one-shot
// propagate rebuild writes to production. Same precedent as the rescore backfill
// and the epc column drop: it is a production data write, so the before state
// must be recoverable and verifiable.
//
// Run: npx tsx --conditions=react-server scripts/snapshot-clickers.ts
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:3}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];

  const summary=(await q(sql`
    SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE source = 'tracked_click')::int AS tracked_click_rows,
           count(*) FILTER (WHERE source <> 'tracked_click')::int AS other_source_rows,
           count(DISTINCT contact_id)::int AS distinct_contacts,
           count(DISTINCT brand_id)::int AS distinct_brands,
           min(created_at)::text AS first_created, max(created_at)::text AS last_created,
           md5(string_agg(id::text, '|' ORDER BY id)) AS checksum
    FROM clickers`))[0];
  console.log("=== clickers summary (pre-backfill) ==="); console.table([summary]);

  console.log("=== by source ===");
  console.table(await q(sql`
    SELECT source, count(*)::int AS rows, count(DISTINCT contact_id)::int AS contacts
    FROM clickers GROUP BY 1 ORDER BY count(*) DESC`));

  // PRIMARY KEYS ONLY. The backfill is additive (INSERT ... WHERE NOT EXISTS),
  // so the recovery property needed is "which rows existed before" — any id
  // absent from this list was added by the backfill and can be removed. Full row
  // bodies cost ~8x the size for no extra recovery power, and this file lives in
  // git permanently.
  const rows=await q(sql`SELECT id FROM clickers ORDER BY id`);
  const csv=["id", ...rows.map(r=>`${r.id}`)].join("\n");
  const out="docs/snapshots/clickers_pre_backfill_2026-08-11.csv";
  writeFileSync(out, csv+"\n");
  console.log(`\nwrote ${rows.length} rows to ${out}`);
  console.log(`checksum (md5 of ordered ids): ${summary.checksum}`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
