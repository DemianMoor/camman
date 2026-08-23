import "./_env-preload";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

// R25 guard: a duplicated DRIP campaign must still be drip, WITH its config.
//
// ⭐ WHY THIS TEST EXISTS. The duplicate route builds its insert as an explicit
// field-by-field values() literal, so any column it does not name silently takes
// the default. Adding campaigns.type without touching that route produced a
// duplicate that came back 'regular' — a 200, a success toast, and the wrong
// data, with nothing failing. Exactly the providers-page PATCH failure mode.
//
// ⭐ AND IT ASSERTS THE CONFIG TOO. Copying `type` alone yields a drip campaign
// with NO config row, which the router skips with "no config row" — a duplicate
// that silently never routes. Copy both or neither.
//
// Preview only: it writes.

const PROD_REF = "rtdarhkkjwcetlmruftl";
let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "";
  if (ref === PROD_REF) {
    console.error("REFUSING to run against PRODUCTION. This test writes.");
    process.exit(1);
  }
  console.log(`target ref: ${ref}`);

  // The route's insert literal is the thing under test, so read it at SOURCE
  // level too: a test that only exercised the DB would pass if someone later
  // deleted the line and the default happened to match.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/api/campaigns/[campaignId]/duplicate/route.ts", "utf8");
  check("duplicate route names `type` in its values() literal",
        /type:\s*source\.type/.test(src), true);
  check("duplicate route copies drip_campaign_configs",
        /INSERT INTO drip_campaign_configs/.test(src), true);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgRows = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = orgRows[0].id;
      const sfx = String(Date.now()).slice(-7);
      const srcRows = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}, ${"dup-" + sfx}, 'dup probe', 'draft', 'drip') RETURNING id
      `)) as unknown as { id: number }[];
      const src2 = srcRows[0].id;
      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, priority)
        VALUES (${src2}, ${orgId}, 'ACA', 42)`);

      // Simulate the route's literal exactly: name the columns it names.
      const copyRows = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        SELECT org_id, ${"dup-" + sfx + "-c"}, 'dup probe (copy)', 'draft', type
        FROM campaigns WHERE id = ${src2} RETURNING id, type
      `)) as unknown as { id: number; type: string }[];
      const copy = copyRows[0];
      check("⭐ the duplicate is still 'drip'", copy.type, "drip");

      await tx.execute(sql`
        INSERT INTO drip_campaign_configs
          (campaign_id, org_id, interest_tag, partner_key_id, start_at, end_at,
           daily_cap, campaign_cap, routing_daily_admission_cap, priority, filters)
        SELECT ${copy.id}, org_id, interest_tag, partner_key_id, start_at, end_at,
               daily_cap, campaign_cap, routing_daily_admission_cap, priority, filters
        FROM drip_campaign_configs WHERE campaign_id = ${src2}`);
      const cfgRows = (await tx.execute(sql`
        SELECT interest_tag, priority FROM drip_campaign_configs WHERE campaign_id = ${copy.id}
      `)) as unknown as { interest_tag: string; priority: number }[];
      const cfg = cfgRows[0];
      check("⭐ the duplicate has its OWN config row", cfg?.interest_tag, "ACA");
      check("...with the source's settings", cfg?.priority, 42);

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }
  check("probe rolled back", rolledBack, true);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}
main().catch(async (e) => {
  console.error(e); await pgConn.end({ timeout: 5 }).catch(() => {}); process.exit(1);
});
