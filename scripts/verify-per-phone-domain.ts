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

  // ⚠️ RETIRED ASSERTION. This block used to assert that NO phone carried an
  // override — "the property that makes this safe to ship", which was true only
  // while Q1 was brand new and nobody had used it. An operator assigning a
  // per-number domain IS the feature, so the check became an alarm that fires
  // when the product is used. Per docs/07-conventions.md the expired invariant
  // is retired and replaced by the durable pair, asserted below:
  //
  //   phone WITHOUT an override     -> resolves exactly as brand-only did
  //   phone WITH an ACTIVE override -> resolves to that override
  const overriding = phones.filter((p) => p.short_domain_id !== null);
  console.log(
    `  ${overriding.length} of ${phones.length} phone(s) carry an override` +
      (overriding.length ? `: ${overriding.map((p) => `#${p.id}->${p.short_domain_id}`).join(", ")}` : ""),
  );

  console.log("\nOverride-free phones must still resolve identically to brand-only:");
  let compared = 0, diffs = 0;
  for (const p of phones) {
    // A phone WITH an override is expected to differ — that is the point of Q1.
    if (p.short_domain_id !== null) continue;
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
  check(
    `all ${compared} (override-free phone, brand) pairs resolve identically to brand-only`,
    diffs === 0 && compared > 0,
    compared === 0
      ? "NO override-free phone remains — this comparison would be vacuous"
      : `${diffs} difference(s)`,
  );

  // The other half of the durable invariant: an ACTIVE override must WIN. Without
  // this, retiring the "nothing overrides" assertion would have left the feature
  // itself unasserted.
  let ovChecked = 0;
  let ovWrong = 0;
  for (const p of overriding) {
    const row = (await db.execute(sql`
      SELECT id, domain, status FROM short_domains WHERE id = ${p.short_domain_id}
    `)) as unknown as { id: number; domain: string; status: string }[];
    // A PENDING override is covered by verify-brand-domain-resolution.ts, which
    // asserts it falls through; only an ACTIVE one is expected to win here.
    if (!row[0] || row[0].status !== "active") continue;
    const resolved = await withOverride(orgId, p.brand_id as number, p.id);
    ovChecked++;
    if (resolved?.id !== row[0].id) {
      ovWrong++;
      console.log(
        `  WRONG phone ${p.id}: override #${row[0].id} ${row[0].domain} -> resolved ${fmt(resolved)}`,
      );
    }
  }
  console.log(`  ${ovChecked} phone(s) with an ACTIVE override checked`);
  check(
    "every phone with an ACTIVE override resolves to that override",
    ovWrong === 0,
    ovChecked === 0
      ? "none present — the override-free half above carried the comparison"
      : `${ovChecked} checked, ${ovWrong} wrong`,
  );

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
  // Compared against the PRE-test count, never against zero: real overrides
  // legitimately exist now, and asserting zero would both fail and imply the
  // wrong repair (deleting an operator's assignment).
  check(
    "rollback left the override count exactly as it was",
    left[0].n === overriding.length,
    `before=${overriding.length} after=${left[0].n}`,
  );

  // ── Brand coherence: a cross-brand assignment must be REFUSED ──────────────
  //
  // Not a neutral choice. Click attribution and per-brand reporting key off the
  // domain, so pointing one brand's number at another brand's host silently
  // credits one brand's engagement to the other and drags sending reputation
  // across. The guard is exercised directly (pure function, no HTTP) so the
  // refusal is proven rather than inferred from the UI clearing the field.
  console.log("\nBrand coherence is enforced server-side:");
  {
    const { verifyShortDomainAssignable } = await import("@/lib/providers/short-domain-assignment");
    const d = (await db.execute(sql`
      SELECT id, domain, brand_id FROM short_domains
      WHERE org_id = ${orgId} AND status = 'active' ORDER BY id LIMIT 1
    `)) as unknown as { id: number; domain: string; brand_id: number }[];
    const other = brands.find((b) => b.id !== d[0]?.brand_id);

    if (!d[0] || !other) {
      check("corpus supports the cross-brand case", false,
            "need one active domain and a second brand to prove the refusal");
    } else {
      const mismatch = await verifyShortDomainAssignable(orgId, d[0].id, other.id);
      check(
        "domain from another brand is REFUSED",
        !mismatch.ok && mismatch.reason === "brand_mismatch",
        `domain ${d[0].domain} (brand ${d[0].brand_id}) onto a brand-${other.id} number -> ${mismatch.ok ? "ACCEPTED" : mismatch.reason}`,
      );
      const matching = await verifyShortDomainAssignable(orgId, d[0].id, d[0].brand_id);
      check(
        "...while the SAME domain on its OWN brand is accepted (not a blanket refusal)",
        matching.ok,
        `domain ${d[0].domain} onto a brand-${d[0].brand_id} number -> ${matching.ok ? "accepted" : matching.reason}`,
      );
      const noBrand = await verifyShortDomainAssignable(orgId, d[0].id, null);
      check(
        "a number with NO brand cannot carry an override",
        !noBrand.ok && noBrand.reason === "brand_mismatch",
        `brandless number -> ${noBrand.ok ? "ACCEPTED" : noBrand.reason}`,
      );
      const cleared = await verifyShortDomainAssignable(orgId, null, other.id);
      check(
        "clearing the override (null) is always allowed",
        cleared.ok,
        `null -> ${cleared.ok ? "accepted" : cleared.reason}`,
      );
    }
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
  await db.$client.end({ timeout: 5 });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await db.$client.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
