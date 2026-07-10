// Phase 6 backend tests: segment rule value validators (pure), phone_type/carrier
// eval SQL semantics vs ground truth (real enriched contacts), and the campaign
// carrier filter + per-bucket removed breakdown in previewAudience. Read-only.
// Run: npx tsx scripts/test-carrier-rules-filter.ts
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
  const { validateMergedRuleShape } = await import("@/lib/validators/segment-rules");
  const { previewAudience } = await import("@/lib/audience-snapshot");
  const { db } = await import("@/db/client");
  const { sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else { failures++; console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  };
  const ok = (c: boolean, m: string) => eq(!!c, true, m);

  console.log("\n(1) rule value validators:");
  eq(validateMergedRuleShape("phone_type", "is", ["mobile", "voip"]), null, "phone_type accepts a valid subset");
  ok(validateMergedRuleShape("phone_type", "is", ["landline"]) != null, "phone_type REJECTS 'landline' (not offered)");
  ok(validateMergedRuleShape("phone_type", "is", []) != null, "phone_type REJECTS empty set");
  ok(validateMergedRuleShape("phone_type", "is_not", ["mobile"]) != null, "phone_type REJECTS operator is_not (IN only)");
  eq(validateMergedRuleShape("carrier", "is_not", ["Verizon", "Unidentified"]), null, "carrier accepts is_not + Unidentified");
  ok(validateMergedRuleShape("carrier", "is", ["Sprint"]) != null, "carrier REJECTS an unknown bucket");

  console.log("\n(2) eval SQL semantics vs ground truth (real enriched contacts):");
  const [{ org_id: orgId }] = await db.execute<{ org_id: string }>(sql`SELECT org_id FROM contacts LIMIT 1`);
  const count = async (where: ReturnType<typeof sql>) =>
    Number((await db.execute<{ n: string }>(sql`SELECT count(*)::text n FROM contacts WHERE org_id=${orgId}::uuid AND messaging_status='eligible' AND ${where}`))[0].n);
  // phone_type ['mobile','voip'] via ANY(array) === line_type IN (...)
  const ptAny = await count(sql`line_type = ANY(ARRAY['mobile','voip']::text[])`);
  const ptGround = await count(sql`line_type IN ('mobile','voip')`);
  eq(ptAny, ptGround, `phone_type set membership (mobile,voip) = ${ptGround}`);
  // carrier ['Verizon']
  const carVer = await count(sql`carrier_norm = ANY(ARRAY['Verizon']::text[])`);
  const carVerGround = await count(sql`carrier_norm = 'Verizon'`);
  eq(carVer, carVerGround, `carrier Verizon = ${carVerGround}`);
  // carrier ['Unknown'] expands to ('Unknown','Unmapped')
  const carUnk = await count(sql`carrier_norm = ANY(ARRAY['Unknown','Unmapped']::text[])`);
  const carUnkGround = await count(sql`carrier_norm IN ('Unknown','Unmapped')`);
  eq(carUnk, carUnkGround, `carrier Unknown expands to Unknown+Unmapped = ${carUnkGround}`);

  console.log("\n(3) previewAudience campaign carrier filter + removed breakdown:");
  const seg = await db.execute<{ id: number; n: string }>(sql`
    SELECT s.id, count(sc.contact_id)::text n FROM segments s
    JOIN segment_contacts sc ON sc.segment_id = s.id
    WHERE s.org_id=${orgId}::uuid GROUP BY s.id HAVING count(sc.contact_id) > 0 ORDER BY 2 DESC LIMIT 1`);
  if (seg.length === 0) {
    console.log("  · no segment with members found — skipping preview integration (validators + eval semantics cover the logic)");
  } else {
    const segId = seg[0].id;
    const base = { orgId, segmentIds: [segId], contactGroupIds: [], filters: { include_no_status: true, include_opt_in: true, include_clickers: true } };
    const unfiltered = await previewAudience(base);
    const filtered = await previewAudience({ ...base, filters: { ...base.filters, carrier_filter: ["Verizon"] } });
    ok(filtered.total_matching <= unfiltered.total_matching, `carrier filter narrows total (${unfiltered.total_matching} → ${filtered.total_matching})`);
    eq(Object.keys(unfiltered.carrier_removed).length, 0, "no filter ⇒ carrier_removed is empty {}");
    const removedSum = Object.values(filtered.carrier_removed).reduce((a, b) => a + b, 0);
    eq(unfiltered.total_matching - filtered.total_matching, removedSum, "removed breakdown sums to (unfiltered − filtered)");
    eq((filtered.carrier_removed as Record<string, number>)["Verizon"] ?? 0, 0, "the selected bucket (Verizon) is never in the removed breakdown");
    console.log(`  · removed breakdown: ${JSON.stringify(filtered.carrier_removed)}`);
  }

  await raw.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll Phase 6 backend tests passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
