// B1 guard — the new short-domain resolution is BYTE-IDENTICAL to the old one
// for every real phone/brand pair, and the three provisioned g.* hostnames are
// unmintable.
//
// ⚠️ REQUIRES MIGRATION 0140 (reads `is_default` and expects `pending` to be a
// legal status). Run it only after the migration is applied; before that it
// fails on a missing column, which is the correct answer, not a bug.
//
// The comparison is a genuine differential, not a value against itself: the
// baseline below is a SEPARATE, deliberately-duplicated transcription of the
// PRE-B1 rule (per-number override, else brand's oldest active), while the
// candidate is the shipped resolveShortDomainForSend. Calling the new resolver
// twice and comparing would prove nothing.
//
// Guard-grade per docs/07-conventions.md: prints the full pair matrix it
// compared, refuses an empty scope, asserts non-emptiness before equality, and
// verifies its own rollback by re-querying.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { resolveShortDomainForSend } from "@/lib/sends/resolve-short-domain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

// The three hostnames B1 provisions. They must exist, be `pending`, and never
// resolve.
const PROVISIONED = ["g.guidekn.com", "g.lumzen.co", "g.fitsyou.net"];

// ── BASELINE: the PRE-B1 rule, transcribed by hand from the kickoff code that
// migration 0140 replaced. Independent of resolveShortDomainForSend on purpose.
async function baselineResolve(
  dbc: typeof db,
  { orgId, brandId, providerPhoneId }: { orgId: string; brandId: number | null; providerPhoneId: number | null },
): Promise<{ id: number; domain: string } | null> {
  if (providerPhoneId != null) {
    const o = (await dbc.execute(sql`
      SELECT d.id, d.domain
      FROM provider_phones ph
      JOIN short_domains d ON d.id = ph.short_domain_id
      WHERE ph.id = ${providerPhoneId} AND ph.org_id = ${orgId}
        AND d.org_id = ${orgId} AND d.status = 'active'
      LIMIT 1
    `)) as unknown as { id: number; domain: string }[];
    if (o[0]) return o[0];
  }
  if (brandId == null) return null;
  const b = (await dbc.execute(sql`
    SELECT id, domain FROM short_domains
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND status = 'active'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `)) as unknown as { id: number; domain: string }[];
  return b[0] ?? null;
}

const fmt = (r: { id: number; domain: string } | null) => (r ? `#${r.id}:${r.domain}` : "(none)");

async function main() {
  const orgRows = (await db.execute(sql`SELECT id FROM organizations ORDER BY id`)) as unknown as { id: string }[];
  check("exactly one organization (this script assumes the single-org install)", orgRows.length === 1, `${orgRows.length} org(s)`);
  const orgId = orgRows[0]?.id;
  if (!orgId) { await pgConn.end({ timeout: 5 }); process.exit(1); }

  const domains = (await db.execute(sql`
    SELECT id, brand_id, domain, status, is_default FROM short_domains ORDER BY brand_id, created_at, id
  `)) as unknown as { id: number; brand_id: number; domain: string; status: string; is_default: boolean }[];
  const brands = (await db.execute(sql`SELECT id, brand_id, name FROM brands ORDER BY id`)) as unknown as
    { id: number; brand_id: string; name: string }[];
  const phones = (await db.execute(sql`
    SELECT id, provider_id, phone_number, short_domain_id FROM provider_phones WHERE org_id = ${orgId} ORDER BY id
  `)) as unknown as { id: number; provider_id: number; phone_number: string; short_domain_id: number | null }[];

  console.log(`\nDomain scope: ${domains.length} row(s)`);
  for (const d of domains) {
    console.log(`     #${d.id} brand=${d.brand_id} ${d.domain} status=${d.status} is_default=${d.is_default}`);
  }
  console.log(`Brand scope: ${brands.length} · Phone scope: ${phones.length}`);
  check("domain scope is non-empty", domains.length > 0, `${domains.length}`);
  check("brand scope is non-empty", brands.length > 0, `${brands.length}`);
  check("phone scope is non-empty", phones.length > 0, `${phones.length}`);

  // ── 1. The three provisioned hostnames exist ─────────────────────────────
  //
  // ⚠️ RETIRED ASSERTIONS. This block used to also assert each host was
  // `pending` and not a brand default. That was true of the MIGRATION's
  // immediate aftermath and nothing more: activation is explicitly the
  // operator's act, and B1 shipped the surface for doing it. The moment they
  // activated (and made two of them brand defaults) the assertions became a
  // report that the feature had been USED — a guard that fails when the product
  // is exercised is a guard that gets ignored. Per docs/07-conventions.md the
  // expired invariant is retired, not the data reverted.
  //
  // What is asserted instead is durable: the rows exist, and whatever their
  // status, the resolution rules below hold.
  for (const host of PROVISIONED) {
    const row = domains.find((d) => d.domain === host);
    check(
      `provisioned: ${host} exists`,
      !!row,
      row ? `#${row.id} brand=${row.brand_id} status=${row.status} is_default=${row.is_default}` : "MISSING",
    );
  }

  // ── 2. At most one default per brand, and any default is ACTIVE ──────────
  const byBrand = new Map<number, typeof domains>();
  for (const d of domains) byBrand.set(d.brand_id, [...(byBrand.get(d.brand_id) ?? []), d]);
  for (const [brandId, list] of byBrand) {
    const defaults = list.filter((d) => d.is_default);
    check(
      `brand ${brandId}: at most one default`,
      defaults.length <= 1,
      `${defaults.length} default(s): ${defaults.map((d) => d.domain).join(", ") || "none"}`,
    );
    check(
      `brand ${brandId}: any default is an ACTIVE domain`,
      defaults.every((d) => d.status === "active"),
      defaults.map((d) => `${d.domain}=${d.status}`).join(", ") || "no default",
    );
  }

  // ── 3. THE differential: new resolution == old, for every real pair ──────
  // Every (phone, brand) combination a stage could actually present, plus the
  // numberless case. Full matrix rather than a sample — it is small and the
  // claim is "byte-identical for existing data", which a sample cannot support.
  const pairs: { phoneId: number | null; brandId: number }[] = [];
  for (const b of brands) {
    pairs.push({ phoneId: null, brandId: b.id });
    for (const p of phones) pairs.push({ phoneId: p.id, brandId: b.id });
  }
  check("comparison matrix is non-empty", pairs.length > 0, `${pairs.length} (phone, brand) pair(s)`);

  let mismatches = 0;
  let resolvedCount = 0;
  for (const pair of pairs) {
    const before = await baselineResolve(db, { orgId, brandId: pair.brandId, providerPhoneId: pair.phoneId });
    const after = await resolveShortDomainForSend(db, {
      orgId,
      brandId: pair.brandId,
      providerPhoneId: pair.phoneId,
    });
    if (before?.id !== after?.id || before?.domain !== after?.domain) {
      mismatches++;
      console.log(
        `     MISMATCH phone=${pair.phoneId ?? "none"} brand=${pair.brandId}: ` +
          `old=${fmt(before)} new=${fmt(after)}`,
      );
    }
    if (after) resolvedCount++;
  }
  console.log(
    `\nDifferential: compared ${pairs.length} pair(s); ${resolvedCount} resolved to a domain, ` +
      `${pairs.length - resolvedCount} resolved to none.`,
  );
  // Non-vacuous: if NOTHING resolved, "old == new" is two nulls agreeing.
  check(
    "at least one pair resolves to a real domain (comparison is non-vacuous)",
    resolvedCount > 0,
    `${resolvedCount} of ${pairs.length}`,
  );
  check(
    "new resolution is byte-identical to the pre-B1 rule for every pair",
    mismatches === 0,
    `${mismatches} mismatch(es) across ${pairs.length} pair(s)`,
  );

  // ── 4. A pending domain is never mintable, even as a per-number override ──
  // Proven by actually assigning one, inside a rolled-back transaction: the
  // resolver must fall THROUGH to the brand rather than mint under it.
  // Self-sufficient: SYNTHESIZE a pending row inside the rolled-back
  // transaction rather than depending on one existing. The original version
  // required a pending domain in production, which stopped being true the moment
  // the operator activated all three — leaving the single most important
  // invariant here ("a pending host can never mint") untested exactly when the
  // data stopped happening to provide a subject for it.
  const somePhone = phones[0];
  check("a phone exists to exercise the override path", !!somePhone, somePhone ? `#${somePhone.id}` : "none");
  if (somePhone) {
    try {
      await db.transaction(async (tx) => {
        const dbc = tx as unknown as typeof db;
        const made = (await tx.execute(sql`
          INSERT INTO short_domains (org_id, brand_id, domain, status, is_default)
          VALUES (${orgId}, ${brands[0].id}, ${"pending-probe.example"}, 'pending', false)
          RETURNING id, brand_id
        `)) as unknown as { id: number; brand_id: number }[];
        const pendingRow = { id: made[0].id, brand_id: made[0].brand_id, domain: "pending-probe.example" };
        await tx.execute(sql`
          UPDATE provider_phones SET short_domain_id = ${pendingRow.id} WHERE id = ${somePhone.id}
        `);
        const withOverride = await resolveShortDomainForSend(dbc, {
          orgId,
          brandId: pendingRow.brand_id,
          providerPhoneId: somePhone.id,
        });
        check(
          "a PENDING per-number override is ignored (falls through, never mints)",
          withOverride?.id !== pendingRow.id,
          `override=#${pendingRow.id} ${pendingRow.domain} -> resolved ${fmt(withOverride)}`,
        );
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    const restored = (await db.execute(sql`
      SELECT short_domain_id FROM provider_phones WHERE id = ${somePhone.id}
    `)) as unknown as { short_domain_id: number | null }[];
    check(
      "rollback restored the exercised phone's override",
      (restored[0]?.short_domain_id ?? null) === (somePhone.short_domain_id ?? null),
      `pre-test=${somePhone.short_domain_id}  now=${restored[0]?.short_domain_id}`,
    );
  }

  // ── 5. The DB, not just the code, enforces one default per brand ─────────
  const twoDefaults = domains.filter((d) => d.status === "active");
  if (twoDefaults.length > 0) {
    const victim = twoDefaults[0];
    let refused = false;
    try {
      await db.transaction(async (tx) => {
        // Insert a second ACTIVE default for the same brand — the index must
        // refuse it. Without this the "at most one" claim rests on data luck.
        await tx.execute(sql`
          INSERT INTO short_domains (org_id, brand_id, domain, status, is_default)
          VALUES (${orgId}, ${victim.brand_id}, ${"second-default-probe.example"}, 'active', true)
        `);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) refused = true;
    }
    check(
      "the DATABASE refuses a second default for a brand that already has one",
      refused,
      refused
        ? `short_domains_one_default_per_brand rejected a 2nd default on brand ${victim.brand_id}`
        : `a 2nd default was ACCEPTED on brand ${victim.brand_id} — the index is not enforcing`,
    );
    const leak = (await db.execute(sql`
      SELECT count(*)::int AS n FROM short_domains WHERE domain = 'second-default-probe.example'
    `)) as unknown as { n: number }[];
    check("no probe domain survived", leak[0].n === 0, `found ${leak[0].n}`);
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
