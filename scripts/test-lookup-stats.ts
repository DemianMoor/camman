// Verification for the Lookup Stats Panel (reads prod data; writes only the org's
// own cache row). Run: npx tsx scripts/test-lookup-stats.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch {
  /* noop */
}
import { sql } from "drizzle-orm";

let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

async function main() {
  const { db } = await import("@/db/client");
  const { computeLookupGroupStats, getLookupGroupStats, refreshLookupGroupStats } =
    await import("@/lib/telnyx/lookup-stats");

  const orgRows = await db.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  const orgId = (orgRows[0] as { id: string }).id;

  console.log("\n1) compute + reconciliation (assertion is permanent, inside compute):");
  const t0 = Date.now();
  const blob = await computeLookupGroupStats(orgId);
  const computeMs = Date.now() - t0;
  console.log(`   computed ${blob.groups.length} groups + summary in ${computeMs} ms`);

  // Show the two stress cases explicitly: most landlines, most (non-landline) opt-outs.
  const byLandline = [...blob.groups].sort((a, b) => b.landlines - a.landlines)[0];
  const byOptout = [...blob.groups].sort((a, b) => b.opt_outs - a.opt_outs)[0];
  for (const [label, g] of [
    ["landline-heaviest", byLandline],
    ["opt-out-heaviest", byOptout],
  ] as const) {
    if (!g) continue;
    console.log(`   [${label}] "${g.name}": total=${g.total} sendable=${g.sendable} landlines=${g.landlines} optOuts(nl)=${g.opt_outs} looked=${g.looked_up} telnyx=${g.telnyx} manual=${g.manual}`);
    ok(g.sendable + g.landlines + g.opt_outs === g.total, `${label}: sendable + landlines + optOuts = total (${g.sendable}+${g.landlines}+${g.opt_outs}=${g.total})`);
    ok(g.telnyx + g.manual === g.looked_up, `${label}: telnyx + manual = looked_up (${g.telnyx}+${g.manual}=${g.looked_up})`);
  }
  console.log("   [summary] distinct contacts across active groups:");
  const s = blob.summary;
  console.log(`     total=${s.total} sendable=${s.sendable} landlines=${s.landlines} optOuts(nl)=${s.opt_outs} looked=${s.looked_up} telnyx=${s.telnyx} manual=${s.manual}`);
  ok(s.sendable + s.landlines + s.opt_outs === s.total, `summary: sendable + landlines + optOuts = total`);
  ok(s.telnyx + s.manual === s.looked_up, `summary: telnyx + manual = looked_up`);

  console.log("\n2) timing (prod scale):");
  const r0 = Date.now();
  const refreshed = await refreshLookupGroupStats(orgId);
  const refreshMs = Date.now() - r0;
  console.log(`   forced refresh (compute + atomic upsert): ${refreshMs} ms`);
  const c0 = Date.now();
  await getLookupGroupStats(orgId);
  const cachedMs = Date.now() - c0;
  console.log(`   cached read: ${cachedMs} ms`);
  ok(cachedMs < 200, `cached read is fast (<200ms): ${cachedMs}ms`);
  ok(refreshed.stale === false, "freshly refreshed cache is not stale");

  console.log("\n3) failed refresh preserves prior cache:");
  const before = await getLookupGroupStats(orgId);
  console.log(`   cache computed_at before failed refresh: ${before.computed_at}`);
  let threw = false;
  try {
    await refreshLookupGroupStats(orgId, async () => {
      throw new Error("forced compute failure");
    });
  } catch (e) {
    threw = true;
    console.log(`   refresh threw as expected: ${(e as Error).message}`);
  }
  ok(threw, "a failing recompute throws (surfaced to the route as 500)");
  const after = await getLookupGroupStats(orgId);
  console.log(`   cache computed_at after  failed refresh: ${after.computed_at}`);
  ok(after.computed_at === before.computed_at, "prior cache computed_at UNCHANGED after failed refresh");
  ok(
    JSON.stringify(after.data.summary) === JSON.stringify(before.data.summary),
    "prior cache data UNCHANGED after failed refresh",
  );

  console.log(
    failures === 0
      ? "\nAll lookup-stats checks passed ✅"
      : `\nFAILED: ${failures} check(s) ✗`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
