// MUST be first: ESM hoists imports, so db/client would otherwise initialise
// its pool before dotenv runs and fall back to the OS user. See
// scripts/_env-preload.ts.
import "./_env-preload";

import { drizzle } from "drizzle-orm/postgres-js"; import postgres from "postgres"; import { sql } from "drizzle-orm";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
import { withFunnelDerived } from "@/lib/keitaro/funnel";
import { denominatorFor } from "@/lib/reporting/counted-clickers";

// Exercises the real reporting path end to end: the shared stage-funnel now
// carries the counted-clicker denominators, and withFunnelDerived divides by
// them. Asserts EPC actually moved off the old redirect denominator.
function assert(c: boolean, m: string) { if (!c) throw new Error(`ASSERTION FAILED: ${m}`); console.log(`  ✓ ${m}`); }

async function main() {
  const c = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const d = drizzle(c);
  const org = (await d.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as {id:string}[];
  const orgId = org[0].id;
  const r = await getStageMetricsInRange(orgId, "2026-06-01", "2026-08-11");
  console.log(`stages=${r.stages.length} periodTotal=${r.clickers.periodTotal} lifetimeTotal=${r.clickers.lifetimeTotal}`);
  console.log(`lifetime revenue total = $${r.clickers.lifetimeRevenueTotal.toFixed(2)}\n`);

  assert(r.clickers.lifetimeTotal > 0, "lifetime denominator is populated");
  assert(r.clickers.lifetimeTotal >= r.clickers.periodTotal, "lifetime >= period (period is a subset)");

  const totals = withFunnelDerived(r.grand, r.clickers.periodTotal);
  const oldEpc = r.grand.redirect_clicks_clean > 0 ? r.grand.revenue / r.grand.redirect_clicks_clean : 0;
  console.log(`OLD epc (revenue/redirects) = $${oldEpc.toFixed(4)}  denom=${r.grand.redirect_clicks_clean}`);
  console.log(`NEW epc (revenue/counted)   = $${totals.epc.toFixed(4)}  denom=${totals.counted_clickers}`);
  assert(totals.counted_clickers === r.clickers.periodTotal, "totals divide by the counted-clicker denominator");
  assert(totals.counted_clickers > r.grand.redirect_clicks_clean, "new denominator is larger than redirects (expected ~8x)");
  assert(totals.epc < oldEpc, "EPC drops, as predicted");
  assert(totals.epc > 0, "EPC is a real number");

  // A tracked stage divides by the cache; a manual one falls back to Keitaro visits.
  const tracked = r.stages.find((s) => s.link_mode === "tracked" && r.clickers.periodByStage.get(s.stage_id));
  if (tracked) {
    const dn = denominatorFor(tracked.link_mode, r.clickers.periodByStage.get(tracked.stage_id), tracked.tally.visit_clicks_clean);
    assert(dn === r.clickers.periodByStage.get(tracked.stage_id), `tracked stage ${tracked.stage_id} uses the cache (${dn})`);
  }
  const manual = r.stages.find((s) => s.link_mode !== "tracked");
  if (manual) {
    const dn = denominatorFor(manual.link_mode, r.clickers.periodByStage.get(manual.stage_id), manual.tally.visit_clicks_clean);
    assert(dn === manual.tally.visit_clicks_clean, `manual stage ${manual.stage_id} falls back to Keitaro visits (${dn})`);
  }
  console.log("\nverify-epc-denominator OK.");
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
