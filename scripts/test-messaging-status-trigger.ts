// Verifies the contacts messaging_status landline-hard-stop trigger (migration
// 0096) against the live schema. ALL work runs in a transaction that is ROLLED
// BACK — no data is changed. Run: npx tsx scripts/test-messaging-status-trigger.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

class Rollback extends Error {}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a === b) console.log(`  ✓ ${m}`);
    else { failures++; console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  };
  const fake = `+1999${Date.now()}`.slice(0, 15);
  const results: Record<string, string> = {};
  try {
    await pg.begin(async (sql) => {
      const [c] = await sql<{ id: string; org_id: string }[]>`
        SELECT id, org_id FROM contacts LIMIT 1`;
      if (!c) throw new Error("no contacts to test against");

      // (b) trigger fires on UPDATE OF line_type -> landline derives not_applicable
      await sql`UPDATE contacts SET line_type = 'landline' WHERE id = ${c.id}`;
      results.updLandline = (await sql<{ messaging_status: string }[]>`
        SELECT messaging_status FROM contacts WHERE id = ${c.id}`)[0].messaging_status;

      // (a) a direct write to messaging_status is overridden back from line_type
      await sql`UPDATE contacts SET messaging_status = 'eligible' WHERE id = ${c.id}`;
      results.directOverride = (await sql<{ messaging_status: string }[]>`
        SELECT messaging_status FROM contacts WHERE id = ${c.id}`)[0].messaging_status;

      // (b) trigger fires on UPDATE back to a non-landline type -> eligible
      await sql`UPDATE contacts SET line_type = 'mobile' WHERE id = ${c.id}`;
      results.updMobile = (await sql<{ messaging_status: string }[]>`
        SELECT messaging_status FROM contacts WHERE id = ${c.id}`)[0].messaging_status;

      // (b) trigger fires on INSERT (landline + mobile)
      results.insLandline = (await sql<{ messaging_status: string }[]>`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${c.org_id}, ${fake}, 'landline') RETURNING messaging_status`)[0].messaging_status;
      results.insMobile = (await sql<{ messaging_status: string }[]>`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${c.org_id}, ${fake + "b"}, 'mobile') RETURNING messaging_status`)[0].messaging_status;

      throw new Rollback(); // undo everything
    });
  } catch (e) {
    if (!(e instanceof Rollback)) { console.error(e); process.exit(1); }
  }

  console.log("\ncontacts messaging_status trigger (all inside a ROLLED-BACK txn):");
  eq(results.updLandline, "not_applicable", "(b) UPDATE OF line_type='landline' -> messaging_status='not_applicable'");
  eq(results.directOverride, "not_applicable", "(a) direct UPDATE messaging_status='eligible' on a landline is REVERTED to not_applicable");
  eq(results.updMobile, "eligible", "(b) UPDATE line_type back to 'mobile' -> 'eligible'");
  eq(results.insLandline, "not_applicable", "(b) INSERT with line_type='landline' -> 'not_applicable'");
  eq(results.insMobile, "eligible", "(b) INSERT with line_type='mobile' -> 'eligible'");

  // Existing base is untouched: all current rows default to eligible/unknown.
  const dist = await pg<{ messaging_status: string; n: string }[]>`
    SELECT messaging_status, count(*)::text AS n FROM contacts GROUP BY 1 ORDER BY 1`;
  console.log("\ncurrent base messaging_status distribution:");
  for (const r of dist) console.log(`  ${r.messaging_status.padEnd(16)} ${r.n}`);

  await pg.end({ timeout: 5 });
  console.log(failures === 0 ? "\nTrigger verified ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
