import "./_env-preload";
import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { getPerformanceReport } from "@/lib/reporting/performance-report";
function assert(c:boolean,m:string){if(!c)throw new Error(`ASSERTION FAILED: ${m}`);console.log(`  ✓ ${m}`);}
const rate=(n:number,d:number)=>d>0?n/d:0;

async function main(){
  const c=postgres(process.env.DATABASE_URL!,{prepare:false,max:5}); const d=drizzle(c);
  const org=(await d.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as {id:string}[];
  const orgId=org[0].id;

  // A deliberately NARROW window — the case that motivated this work.
  const from="2026-08-09", to="2026-08-11";
  for (const dim of ["offer","number","sequence","group"] as const) {
    const r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null });
    const withLife = r.rows.filter(x => x.lifetime_clickers > 0);
    assert(r.rows.length > 0, `${dim}: returns rows`);
    assert(withLife.length > 0, `${dim}: rows carry a lifetime denominator`);
    assert(
      r.rows.every(x => x.lifetime_clickers >= x.counted_clickers - 0.01),
      `${dim}: lifetime denominator >= period denominator on every row`,
    );
    const diverged = withLife.filter(x =>
      Math.abs(rate(x.lifetime_revenue, x.lifetime_clickers) - rate(x.revenue, x.counted_clickers)) > 0.001);
    console.log(`    ${dim}: ${r.rows.length} rows, ${diverged.length} where lifetime != period EPC`);
    const s = withLife[0];
    if (s) console.log(`    e.g. ${s.label}: lifetime $${rate(s.lifetime_revenue,s.lifetime_clickers).toFixed(4)} (${Math.round(s.lifetime_clickers)} clicks) vs period $${rate(s.revenue,s.counted_clickers).toFixed(4)} (${Math.round(s.counted_clickers)} clicks)`);
  }

  // By-Group: the lifetime pair must be fractionally split like its period twin,
  // i.e. non-integer shares are expected and the totals must stay sane.
  const g = await getPerformanceReport(orgId, "group", { from, to, providerPhoneId: null });
  const anyFractional = g.rows.some(x => x.lifetime_clickers % 1 !== 0);
  assert(g.rows.length > 0, "group: rows present");
  assert(anyFractional || g.rows.length === 1, "group: lifetime clickers are fractionally split like the period figure");
  assert(g.rows.every(x => x.lifetime_revenue >= 0), "group: split lifetime revenue is non-negative");

  console.log("\nverify-lifetime-display OK.");
  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1)});
