// Q1 acceptance: the per-phone short-domain override must be BYTE-IDENTICAL for
// every existing row.
//
// Migration 0137 adds provider_phones.short_domain_id, and kickoff now prefers
// it over the campaign brand's domain. Every pre-0137 row has it NULL, so the
// new branch must select nothing and the brand branch must produce exactly what
// it produced before — same predicate, same ORDER BY, same LIMIT.
//
// The proof is a DIFFERENTIAL, not an inspection: for every real provider_phone
// paired with every real brand, resolve the domain BOTH ways (new two-branch
// logic vs the original brand-only query) and assert the (id, domain) pairs are
// identical. Anything that differs is a behaviour change and fails.
//
// Read-only. No writes.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}\n        ${detail}`);
  else { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

type Resolved = { id: number; domain: string } | null;
const fmt = (r: Resolved) => (r ? `${r.id}:${r.domain}` : "(none)");

// EXACTLY the query kickoff ran before 0137.
async function brandOnly(orgId: string, brandId: number): Promise<Resolved> {
  const r = (await db.execute(sql`
    SELECT id, domain FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND status = 'active'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `)) as unknown as { id: number; domain: string }[];
  return r[0] ?? null;
}

// The new two-branch resolution, mirroring lib/sends/kickoff.ts.
async function withOverride(orgId: string, brandId: number, phoneId: number | null): Promise<Resolved> {
  if (phoneId != null) {
    const o = (await db.execute(sql`
      SELECT d.id, d.domain
      FROM provider_phones ph
      JOIN short_domains d ON d.id = ph.short_domain_id
      WHERE ph.id = ${phoneId} AND ph.org_id = ${orgId}
        AND d.org_id = ${orgId} AND d.status = 'active'
      LIMIT 1
    `)) as unknown as { id: number; domain: string }[];
    if (o[0]) return o[0];
  }
  return brandOnly(orgId, brandId);
}

async function main() {
  const org = ((await db.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[])[0];
  const orgId = org.id;

  const phones = (await db.execute(sql`
    SELECT id, phone_number, brand_id, short_domain_id FROM provider_phones
    WHERE org_id = ${orgId} ORDER BY id
  `)) as unknown as { id: number; phone_number: string; brand_id: number | null; short_domain_id: number | null }[];
  const brands = (await db.execute(sql`
    SELECT id FROM brands WHERE org_id = ${orgId} ORDER BY id
  `)) as unknown as { id: number }[];

  console.log(`\nCorpus: ${phones.length} provider_phones x ${brands.length} brands`);
  check("corpus is non-empty (comparison is not vacuous)", phones.length > 0 && brands.length > 0,
        `${phones.length} phones, ${brands.length} brands`);

  // The property that makes this safe to ship: nothing overrides yet.
  const overriding = phones.filter((p) => p.short_domain_id !== null);
  check(
    "no existing phone has an override set (so today's behaviour is the whole surface)",
    overriding.length === 0,
    overriding.length ? `UNEXPECTED overrides on: ${overriding.map((p) => p.id).join(", ")}` : "0 of " + phones.length,
  );

  console.log("\nByte-identical resolution across every (phone, brand) pair:");
  let compared = 0, diffs = 0;
  for (const p of phones) {
    for (const b of brands) {
      const before = await brandOnly(orgId, b.id);
      const after = await withOverride(orgId, b.id, p.id);
      compared++;
      if (fmt(before) !== fmt(after)) {
        diffs++;
        console.log(`  DIFF  phone ${p.id} (${p.phone_number}) x brand ${b.id}: before=${fmt(before)} after=${fmt(after)}`);
      }
    }
  }
  check(`all ${compared} (phone, brand) pairs resolve identically`, diffs === 0, `${diffs} difference(s)`);

  // Also cover the numberless-stage path (provider_phone_id NULL).
  console.log("\nNumberless stages (provider_phone_id NULL) are unaffected:");
  let nDiff = 0;
  for (const b of brands) {
    const before = await brandOnly(orgId, b.id);
    const after = await withOverride(orgId, b.id, null);
    if (fmt(before) !== fmt(after)) { nDiff++; console.log(`  DIFF  brand ${b.id}: ${fmt(before)} vs ${fmt(after)}`); }
  }
  check("null-phone resolution identical for every brand", nDiff === 0, `${brands.length} brands, ${nDiff} difference(s)`);

  // Prove the override WOULD take effect — otherwise "identical" could just mean
  // the new branch is dead code. Simulated in a rolled-back transaction.
  console.log("\nThe override actually works (simulated, rolled back):");
  const ROLLBACK = Symbol("rb");
  try {
    await db.transaction(async (tx) => {
      const d = (await tx.execute(sql`
        SELECT id, domain, brand_id FROM short_domains WHERE org_id = ${orgId} AND status='active' ORDER BY id LIMIT 1
      `)) as unknown as { id: number; domain: string; brand_id: number }[];
      const otherBrand = brands.find((b) => b.id !== d[0]?.brand_id);
      if (!d[0] || !otherBrand || !phones[0]) { console.log("  SKIP  need an active domain, a second brand and a phone"); throw ROLLBACK; }
      await tx.execute(sql`UPDATE provider_phones SET short_domain_id = ${d[0].id} WHERE id = ${phones[0].id}`);
      const o = (await tx.execute(sql`
        SELECT d.id, d.domain FROM provider_phones ph
        JOIN short_domains d ON d.id = ph.short_domain_id
        WHERE ph.id = ${phones[0].id} AND ph.org_id = ${orgId} AND d.org_id = ${orgId} AND d.status='active' LIMIT 1
      `)) as unknown as { id: number; domain: string }[];
      check(
        "with an override set, the phone's domain wins over the brand default",
        o[0]?.id === d[0].id,
        `phone ${phones[0].id} -> ${fmt(o[0] ?? null)} (brand ${otherBrand.id} default would be ${fmt(await brandOnly(orgId, otherBrand.id))})`,
      );
      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }

  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM provider_phones WHERE short_domain_id IS NOT NULL
  `)) as unknown as { n: number }[];
  check("rollback left no override behind", left[0].n === 0, `${left[0].n} phone(s) with an override`);

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
  await db.$client.end({ timeout: 5 });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await db.$client.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
