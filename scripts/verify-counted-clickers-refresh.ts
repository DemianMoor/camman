import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { refreshCountedClickers, getCountedClickersRefreshedAt } from "@/lib/reporting/counted-clickers";
function assert(c:boolean,m:string){if(!c)throw new Error(`ASSERTION FAILED: ${m}`);console.log(`  ✓ ${m}`);}
async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:1}); const d=drizzle(c);
  const full = await refreshCountedClickers(d,"full");
  console.log(`full: rows=${full.rows} rescued=${full.rescuedByConversion} ${full.durationMs}ms`);
  const stampAfterFull = await getCountedClickersRefreshedAt(d);
  assert(!!stampAfterFull, `full pass stamps the refresh time (${stampAfterFull})`);

  const inc = await refreshCountedClickers(d,"incremental");
  console.log(`incremental: rows=${inc.rows} ${inc.durationMs}ms`);
  assert(inc.durationMs < full.durationMs, `incremental (${inc.durationMs}ms) is cheaper than full (${full.durationMs}ms)`);
  assert(Math.abs(inc.rows-full.rows) <= 50, `incremental preserves the row count (${full.rows} -> ${inc.rows})`);
  const stampAfterInc = await getCountedClickersRefreshedAt(d);
  assert(stampAfterInc === stampAfterFull, "incremental does NOT advance the full-rebuild stamp (staleness stays visible)");

  // The repair property: delete a row, incremental must NOT resurrect an old one
  // outside its window, but full must.
  const victim = (await d.execute(sql`SELECT stage_id, contact_id FROM counted_clickers WHERE rescued_by_conversion = false AND first_click_at < now() - interval '2 days' LIMIT 1`)) as unknown as {stage_id:number;contact_id:string}[];
  if (victim[0]) {
    await d.execute(sql`DELETE FROM counted_clickers WHERE stage_id=${victim[0].stage_id} AND contact_id=${victim[0].contact_id}::uuid`);
    await refreshCountedClickers(d,"incremental");
    const afterInc=(await d.execute(sql`SELECT count(*)::int AS n FROM counted_clickers WHERE stage_id=${victim[0].stage_id} AND contact_id=${victim[0].contact_id}::uuid`)) as unknown as {n:number}[];
    assert(Number(afterInc[0].n)===0, "incremental does not repair an old row (outside its 6h window) — as designed");
    await refreshCountedClickers(d,"full");
    const afterFull=(await d.execute(sql`SELECT count(*)::int AS n FROM counted_clickers WHERE stage_id=${victim[0].stage_id} AND contact_id=${victim[0].contact_id}::uuid`)) as unknown as {n:number}[];
    assert(Number(afterFull[0].n)===1, "full rebuild REPAIRS it — the self-healing guarantee");
  }
  console.log("\nverify-counted-clickers-refresh OK.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
