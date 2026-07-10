// Phase 4 verification: the messaging_status='eligible' gate. Two parts:
//  (1) FUNCTIONAL (rolled-back txn): a contact in a segment's manual membership is
//      returned by buildSegmentAudienceClause when eligible, and DISAPPEARS once it
//      becomes a landline — while remaining present in contacts (Contacts screen).
//  (2) INDEX SELECTION (EXPLAIN): the gated scans use the *_elig_idx partial indexes.
//      With all rows currently eligible the planner may seqscan broad reads, so we
//      also (a) prove usability via SET enable_seqscan=off and (b) test a SELECTIVE
//      scan that should pick the partial index naturally today.
// Run: npx tsx scripts/test-eligible-gate.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch { /* noop */ }

async function main() {
  const { buildSegmentAudienceClause } = await import("@/lib/segment-rules-eval");
  const { db } = await import("@/db/client");
  const { sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const ok = (c: boolean, m: string) => { if (c) console.log(`  ✓ ${m}`); else { failures++; console.error(`  ✗ ${m}`); } };

  const org = await db.execute<{ org_id: string }>(sql`SELECT org_id FROM contacts LIMIT 1`);
  const orgId = org[0].org_id;

  // ---- (1) functional gate, all inside a rolled-back txn ----
  class Rollback extends Error {}
  const fnResults: Record<string, boolean> = {};
  try {
    await db.transaction(async (tx) => {
      const phone = `+1999${Date.now()}`.slice(0, 15);
      const [c] = await tx.execute<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${orgId}::uuid, ${phone}, 'mobile') RETURNING id`);
      const [seg] = await tx.execute<{ id: number }>(sql`
        INSERT INTO segments (org_id, segment_id, name, status)
        VALUES (${orgId}::uuid, ${"tmp-elig-" + Date.now()}, 'tmp eligible gate test', 'active')
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO segment_contacts (org_id, segment_id, contact_id)
        VALUES (${orgId}::uuid, ${seg.id}::int, ${c.id}::uuid)`);

      const clause = await buildSegmentAudienceClause(seg.id, orgId);
      const present1 = await tx.execute<{ contact_id: string }>(sql`
        SELECT contact_id FROM (${clause}) s WHERE contact_id = ${c.id}::uuid`);
      fnResults.eligibleIncluded = present1.length === 1;

      // Flip to landline — trigger sets messaging_status='not_applicable'.
      await tx.execute(sql`UPDATE contacts SET line_type='landline' WHERE id=${c.id}::uuid`);
      const clause2 = await buildSegmentAudienceClause(seg.id, orgId);
      const present2 = await tx.execute<{ contact_id: string }>(sql`
        SELECT contact_id FROM (${clause2}) s WHERE contact_id = ${c.id}::uuid`);
      fnResults.landlineExcluded = present2.length === 0;

      // Still present in contacts (Contacts screen sees it).
      const inContacts = await tx.execute<{ messaging_status: string }>(sql`
        SELECT messaging_status FROM contacts WHERE id=${c.id}::uuid`);
      fnResults.stillInContacts =
        inContacts.length === 1 && inContacts[0].messaging_status === "not_applicable";

      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }

  console.log("\n(1) functional gate (rolled back):");
  ok(fnResults.eligibleIncluded, "eligible manual member IS in the segment audience");
  ok(fnResults.landlineExcluded, "after becoming a landline, it DISAPPEARS from the segment audience (#3)");
  ok(fnResults.stillInContacts, "landline still present in contacts as not_applicable (Contacts screen only)");

  // ---- (2) index selection ----
  console.log("\n(2) index selection (EXPLAIN):");
  const planText = async (setup: string, query: ReturnType<typeof sql>) => {
    if (setup) await raw.unsafe(setup);
    const rows = await db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${query}`);
    if (setup) await raw.unsafe("RESET enable_seqscan");
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  };

  // is_not universe scan (whole org, all eligible now → likely seqscan; prove usable)
  const uniPlanForced = await planText(
    "SET enable_seqscan=off",
    sql`SELECT id FROM contacts WHERE org_id=${orgId}::uuid AND messaging_status='eligible'`,
  );
  ok(/contacts_org_eligible_idx/.test(uniPlanForced),
    "is_not universe scan USES contacts_org_eligible_idx (enable_seqscan=off — proves literal matches the partial index)");

  // Selective contact_added scan (recent window) — should pick the partial index NOW.
  const addedPlanNatural = await planText(
    "",
    sql`SELECT id FROM contacts WHERE org_id=${orgId}::uuid AND messaging_status='eligible' AND created_at >= now() - interval '2 days'`,
  );
  const addedPlanForced = await planText(
    "SET enable_seqscan=off",
    sql`SELECT id FROM contacts WHERE org_id=${orgId}::uuid AND messaging_status='eligible' AND created_at >= now() - interval '2 days'`,
  );
  const addedUsesIdx = /contacts_org_created_eligible_idx/.test(addedPlanNatural);
  ok(/contacts_org_created_eligible_idx/.test(addedPlanForced),
    "contact_added scan USES contacts_org_created_eligible_idx (forced — proves literal matches)");
  console.log(`  · contact_added natural plan ${addedUsesIdx ? "picks the partial index NOW ✓" : "seqscans now (all-eligible; deferred re-check after not_applicable rows exist)"}`);

  await raw.end({ timeout: 5 });
  console.log(failures === 0 ? "\nEligible-gate verification passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
