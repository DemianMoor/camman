import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";

// READ-ONLY. Pre-drop snapshot of keitaro_stage_results.epc.
// The column is write-only (nothing reads it) and stores a THIRD EPC definition
// — revenue over RAW redirect clicks. It is being dropped. This export is the
// reconstruction record; unrecoverable once the column is gone.
//
// Run: npx tsx --conditions=react-server scripts/snapshot-keitaro-epc-column.ts
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:1}); const d=drizzle(c);
  const q=async(x:ReturnType<typeof sql>)=>(await d.execute(x)) as unknown as Record<string,unknown>[];

  const summary=(await q(sql`
    SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE epc <> 0)::int AS nonzero_rows,
           min(stat_date)::text AS first_date, max(stat_date)::text AS last_date,
           round(min(epc),4)::text AS min_epc, round(max(epc),4)::text AS max_epc,
           round(avg(epc),4)::text AS avg_epc, round(sum(epc),4)::text AS sum_epc,
           md5(string_agg(stage_id::text||':'||stat_date::text||':'||epc::text, '|' ORDER BY stage_id, stat_date)) AS checksum
    FROM keitaro_stage_results`))[0];
  console.log("=== summary ==="); console.table([summary]);

  const rows=await q(sql`
    SELECT stage_id, stat_date::text AS stat_date, epc::text AS epc
    FROM keitaro_stage_results ORDER BY stage_id, stat_date`);
  const csv=["stage_id,stat_date,epc",...rows.map(r=>`${r.stage_id},${r.stat_date},${r.epc}`)].join("\n");
  const out="docs/snapshots/keitaro_stage_results_epc_2026-08-11.csv";
  writeFileSync(out, csv+"\n");
  console.log(`\nwrote ${rows.length} rows to ${out}`);
  console.log(`checksum (md5 of stage:date:epc): ${summary.checksum}`);
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
