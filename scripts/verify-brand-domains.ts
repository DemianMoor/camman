// Brand short-domain WRITE surface — the acceptance test for the B1 rewrite.
//
// This script is the one that CAUGHT the defect: it had been red on main since
// migration 0136, failing with
//   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
//          specification
// because `applyBrandShortDomain` ended in `ON CONFLICT (brand_id) DO UPDATE`
// while 0136 had dropped `short_domains_brand_id_uniq`. Saving a brand's short
// domain 500'd in production from the day 0136 landed, and nobody re-ran this.
//
// It now exercises the replacement surface: add (as pending) / activate /
// deactivate / set-default / delete-by-id, plus the two invariants that make the
// old failure mode unrepeatable:
//
//   • NO BRAND-WIDE DELETE PATH EXISTS ANYWHERE (source-level assertion). The old
//     clear branch ran DELETE … WHERE org_id = … AND brand_id = …, which post-0136
//     wipes every domain a brand has instead of the one being removed.
//   • at most one default per brand is enforced by the DATABASE, not by code.
//
// All writes happen inside a transaction that is ALWAYS rolled back, and the
// rollback is verified afterwards by re-querying rather than trusted.
//
// Run: npx tsx scripts/verify-brand-domains.ts
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import {
  addShortDomain,
  deleteShortDomain,
  listBrandShortDomains,
  normalizeShortDomain,
  setShortDomainDefault,
  setShortDomainStatus,
} from "@/lib/sends/short-domain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  // ── 1. Hostname normalization (unchanged behaviour, still guarded) ────────
  console.log("\nnormalizeShortDomain:");
  const n1 = normalizeShortDomain("https://go.brand.co/lp?x=1");
  check("strips scheme + path", n1.ok && n1.host === "go.brand.co", JSON.stringify(n1));
  const n2 = normalizeShortDomain("GO.Brand.CO:8080");
  check("lowercases + strips port", n2.ok && n2.host === "go.brand.co", JSON.stringify(n2));
  const n3 = normalizeShortDomain("not a domain");
  check("rejects junk", !n3.ok, JSON.stringify(n3));
  const n4 = normalizeShortDomain("");
  check("empty input yields null host", n4.ok && n4.host === null, JSON.stringify(n4));

  // ── 2. NO BRAND-WIDE DELETE PATH (the negative test) ─────────────────────
  //
  // Source-level, repo-wide, and deliberately blunt: any `DELETE FROM
  // short_domains` whose predicate mentions brand_id is the exact shape of the
  // defect being retired. A data-level test cannot prove absence; this can.
  const ROOTS = ["lib", "app", "scripts"];
  const offenders: string[] = [];
  let scanned = 0;
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        await walk(full);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
        scanned++;
        const src = await fs.readFile(full, "utf8");
        // Normalize whitespace so a line-wrapped statement still matches.
        const flat = src.replace(/\s+/g, " ");
        const re = /DELETE\s+FROM\s+(?:public\.)?short_domains([^;`]*)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(flat)) !== null) {
          const predicate = m[1] ?? "";
          if (/brand_id/i.test(predicate)) {
            offenders.push(`${full.replace(/\\/g, "/")} :: DELETE …${predicate.slice(0, 90).trim()}`);
          }
        }
      }
    }
  }
  for (const r of ROOTS) await walk(path.join(process.cwd(), r));
  console.log(`\nSource scan: ${scanned} .ts/.tsx file(s) under ${ROOTS.join(", ")}`);
  // A scan that found nothing to read would "pass" vacuously.
  check("source scan covered a non-trivial number of files", scanned > 100, `${scanned} files`);
  check(
    "NO brand-keyed DELETE on short_domains exists anywhere in the repo",
    offenders.length === 0,
    offenders.length ? offenders.join("\n     ") : "delete-by-id is the only delete path",
  );
  // And prove the scanner can actually see a violation — otherwise "0 offenders"
  // might just mean the regex never matches anything.
  const selfTest = "DELETE FROM short_domains WHERE org_id = $1 AND brand_id = $2".replace(/\s+/g, " ");
  check(
    "the scanner's own pattern detects a brand-keyed DELETE (scanner is not blind)",
    /DELETE\s+FROM\s+(?:public\.)?short_domains([^;`]*)/i.test(selfTest) &&
      /brand_id/i.test(selfTest),
    "self-test string matched",
  );

  // ── 3. The write surface, end to end, rolled back ────────────────────────
  const brandRows = (await db.execute(sql`
    SELECT id, org_id, name FROM brands ORDER BY id LIMIT 2
  `)) as unknown as { id: number; org_id: string; name: string }[];
  check("at least two brands exist to exercise cross-brand conflict", brandRows.length >= 2, `${brandRows.length}`);
  if (brandRows.length < 2) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const orgId = brandRows[0].org_id;
  const brandA = brandRows[0].id;
  const brandB = brandRows[1].id;
  console.log(`\nExercising brands #${brandA} (${brandRows[0].name}) and #${brandB} (${brandRows[1].name})`);

  const beforeCounts = (await db.execute(sql`
    SELECT count(*)::int AS n FROM short_domains WHERE org_id = ${orgId}
  `)) as unknown as { n: number }[];

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;

      // ADD — lands pending, never active.
      const a1 = await addShortDomain(dbc, { orgId, brandId: brandA, rawDomain: "https://go.verify-a.co/x" });
      check("add: normalizes and inserts", a1.ok && a1.domain === "go.verify-a.co", JSON.stringify(a1));
      if (!a1.ok) throw ROLLBACK;
      const listed = await listBrandShortDomains(dbc, { orgId, brandId: brandA });
      const added = listed.find((r) => r.id === a1.id);
      check("add: lands as PENDING, never active", added?.status === "pending", `status=${added?.status}`);
      check("add: is not a brand default", added?.is_default === false, `is_default=${added?.is_default}`);

      // ADD conflict — refused with a message, never silently adopted.
      const a2 = await addShortDomain(dbc, { orgId, brandId: brandB, rawDomain: "go.verify-a.co" });
      check(
        "add: a hostname already registered to another brand is REFUSED",
        !a2.ok && a2.reason === "domain_taken",
        JSON.stringify(a2),
      );
      const stillA = (await tx.execute(sql`
        SELECT brand_id FROM short_domains WHERE org_id = ${orgId} AND domain = 'go.verify-a.co'
      `)) as unknown as { brand_id: number }[];
      check(
        "add: the refused conflict did NOT move the row to the other brand",
        stillA[0]?.brand_id === brandA,
        `owner brand=${stillA[0]?.brand_id} (expected ${brandA})`,
      );

      // SET DEFAULT on a pending row — refused.
      const dPending = await setShortDomainDefault(dbc, { orgId, id: a1.id });
      check(
        "set-default: refuses a PENDING domain (activate first)",
        !dPending.ok && dPending.reason === "not_active",
        JSON.stringify(dPending),
      );

      // ACTIVATE, then set default.
      const act = await setShortDomainStatus(dbc, { orgId, id: a1.id, status: "active" });
      check("activate: status becomes active", act.ok && act.status === "active", JSON.stringify(act));
      const dOk = await setShortDomainDefault(dbc, { orgId, id: a1.id });
      check("set-default: succeeds on an ACTIVE domain", dOk.ok, JSON.stringify(dOk));

      // A SECOND default for the same brand must displace the first, not error
      // — and must never leave two.
      const a3 = await addShortDomain(dbc, { orgId, brandId: brandA, rawDomain: "go.verify-a2.co" });
      if (!a3.ok) throw new Error("fixture add failed");
      await setShortDomainStatus(dbc, { orgId, id: a3.id, status: "active" });
      const d2 = await setShortDomainDefault(dbc, { orgId, id: a3.id });
      check("set-default: moving the default succeeds", d2.ok, JSON.stringify(d2));
      const defaults = (await tx.execute(sql`
        SELECT id FROM short_domains WHERE org_id = ${orgId} AND brand_id = ${brandA} AND is_default
      `)) as unknown as { id: number }[];
      check(
        "set-default: exactly ONE default remains for the brand",
        defaults.length === 1 && defaults[0].id === a3.id,
        `${defaults.length} default(s), id=${defaults[0]?.id} (expected ${a3.id})`,
      );

      // DEACTIVATE clears the default — a non-active row must never be default.
      const deact = await setShortDomainStatus(dbc, { orgId, id: a3.id, status: "pending" });
      check("deactivate: status becomes pending", deact.ok && deact.status === "pending", JSON.stringify(deact));
      const afterDeact = (await tx.execute(sql`
        SELECT is_default FROM short_domains WHERE id = ${a3.id}
      `)) as unknown as { is_default: boolean }[];
      check(
        "deactivate: also CLEARS is_default (a pending row is never the default)",
        afterDeact[0]?.is_default === false,
        `is_default=${afterDeact[0]?.is_default}`,
      );

      // The DATABASE, not the code, enforces one default per brand.
      let refused = false;
      try {
        await tx.execute(sql`SAVEPOINT two_defaults`);
        await tx.execute(sql`
          UPDATE short_domains SET is_default = true
          WHERE org_id = ${orgId} AND brand_id = ${brandA} AND id IN (${a1.id}, ${a3.id})
        `);
        await tx.execute(sql`RELEASE SAVEPOINT two_defaults`);
      } catch {
        refused = true;
        await tx.execute(sql`ROLLBACK TO SAVEPOINT two_defaults`);
      }
      check(
        "the DATABASE refuses two defaults on one brand (not just the code)",
        refused,
        refused ? "short_domains_one_default_per_brand rejected it" : "TWO defaults were accepted",
      );

      // DELETE by id — removes exactly one row, leaves the brand's others alone.
      const beforeDel = await listBrandShortDomains(dbc, { orgId, brandId: brandA });
      const del = await deleteShortDomain(dbc, { orgId, id: a3.id });
      check("delete: by id succeeds", del.ok, JSON.stringify(del));
      const afterDel = await listBrandShortDomains(dbc, { orgId, brandId: brandA });
      check(
        "delete: removes EXACTLY ONE row, the brand's others survive",
        afterDel.length === beforeDel.length - 1 && afterDel.some((r) => r.id === a1.id),
        `${beforeDel.length} -> ${afterDel.length}; sibling ${a1.id} present: ${afterDel.some((r) => r.id === a1.id)}`,
      );

      // DELETE refuses a domain with minted links.
      const linked = (await tx.execute(sql`
        SELECT short_domain_id FROM links WHERE short_domain_id IS NOT NULL LIMIT 1
      `)) as unknown as { short_domain_id: number }[];
      if (linked[0]) {
        const guarded = await deleteShortDomain(dbc, { orgId, id: linked[0].short_domain_id });
        check(
          "delete: refuses a domain that has minted links",
          !guarded.ok && guarded.reason === "domain_in_use",
          JSON.stringify(guarded),
        );
      } else {
        check("a linked domain exists to exercise the minted-links guard", false, "no links rows found");
      }

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── 4. Rollback verified by re-query ─────────────────────────────────────
  const afterCounts = (await db.execute(sql`
    SELECT count(*)::int AS n FROM short_domains WHERE org_id = ${orgId}
  `)) as unknown as { n: number }[];
  check(
    "rollback restored the short_domains row count",
    afterCounts[0].n === beforeCounts[0].n,
    `before=${beforeCounts[0].n} after=${afterCounts[0].n}`,
  );
  const strays = (await db.execute(sql`
    SELECT count(*)::int AS n FROM short_domains WHERE domain LIKE 'go.verify-a%'
  `)) as unknown as { n: number }[];
  check("no verify fixture domain survived", strays[0].n === 0, `found ${strays[0].n}`);

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
