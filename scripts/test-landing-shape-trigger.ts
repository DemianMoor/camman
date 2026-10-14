import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { loadBrandLandingPairs } from "@/lib/api/brand-landing-pairs";
import {
  checkBrandLandingPair,
  computeBrandLandingImpact,
  LANDING_PAIR_TAKEN_CODE,
  LANDING_PATH_COLLIDES_CODE,
} from "@/lib/api/brand-landing";
import { validateBrandLpShape } from "@/lib/stage-url";

// The link_destinations trigger (0212) + the brand-save guards, against a REAL
// database. PREVIEW ONLY — it writes fixtures and must never touch production:
//
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo \
//     scripts/test-landing-shape-trigger.ts
//
// Everything runs in ONE transaction that is rolled back at the end (a sentinel
// throw), so it leaves nothing behind; the script re-checks that afterwards.
//
//   1. The 14 #362 cases against the TRIGGER, with fixture brands carrying
//      production's four pairs — and the app mirror fed the pairs read back from
//      the same rows must give the same verdict on every case.
//   2. A new brand with its own host/path is accepted; after a host change its
//      old host is refused (fresh insert AND the mint's ON CONFLICT update path).
//   3. Org isolation: another org's pairs do not validate a URL.
//   4. Brand-save guards: pair taken, path collision (count + examples), clean
//      path accepted, a path already in scope not checked.
//   5. brands_landing_pair_uniq backstop.

const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
if (!(process.env.DATABASE_URL ?? "").includes(PREVIEW_REF)) {
  console.error(`Refusing: DATABASE_URL is not the preview project (${PREVIEW_REF}).`);
  process.exit(2);
}

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}

const CASES: [string, "A" | "R"][] = [
  ["https://www.guidekn.com/lp/orv?sub_id3=8_62_082226_1_s1_c1", "A"],
  ["https://www.lumzen.co/lp/orv?sub_id3=8_62_082226_1_s1_c1&utm_source=x", "A"],
  ["https://blogcascade.com/bcf/sas?sub_id3=8_157_101326_1_s1_c1102", "A"],
  ["https://blogcascade.com/bcf/sas?sub_id3=8_157_101326_1_s1_c1102&utm_source=x", "A"],
  ["https://blogcascade.com/article/x?utm_source=y", "A"],
  ["https://partner.example/offer?a=1", "A"],
  ["https://www.blogcascade.com/bcf/sas?sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas", "R"],
  ["https://blogcascade.com/bcf/sas?subid3=sub_id3", "R"],
  ["https://blogcascade.com/bcf/sas8_157_1?sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas?utm_source=x&sub_id3=T1", "R"],
  ["https://blogcascade.com/bcf/sas?sub_id3=T%3F", "R"],
  ["https://blogcascade.com/lp/sas?sub_id3=T1", "R"],
  ["https://www.guidekn.com/lp/knd8_62_1?sub_id3=T1", "R"],
];

class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Insert one destination inside a SAVEPOINT; "A" if it stuck, "R" on 23514.
async function tryInsert(tx: Tx, orgId: string, url: string): Promise<"A" | "R" | string> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(sql`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${orgId}::uuid, ${url}, md5(${url} || clock_timestamp()::text))
      `);
    });
    return "A";
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    return code === "23514" ? "R" : `error ${code}: ${(e as Error).message}`;
  }
}

async function main() {
  const sfx = Date.now().toString(36);
  const orgs = (await db.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 2`)) as unknown as { id: string }[];
  const orgA = orgs[0]?.id;
  const orgB = orgs[1]?.id;
  if (!orgA) throw new Error("no organization on preview");
  const destBefore = (await db.execute(sql`SELECT count(*)::int AS n FROM link_destinations`)) as unknown as { n: number }[];
  const brandsBefore = (await db.execute(sql`SELECT count(*)::int AS n FROM brands`)) as unknown as { n: number }[];

  try {
    await db.transaction(async (tx) => {
      // Fixture brands = production's four pairs, in org A.
      const mk = async (host: string, path: string) => {
        const r = (await tx.execute(sql`
          INSERT INTO brands (org_id, brand_id, name, landing_host, landing_path)
          VALUES (${orgA}::uuid, ${`t212-${host}-${sfx}`}, ${`T212 ${host}`}, ${host}, ${path})
          RETURNING id
        `)) as unknown as { id: number }[];
        return r[0].id;
      };
      await mk("www.guidekn.com", "lp");
      await mk("www.lumzen.co", "lp");
      await mk("www.fitsyou.net", "lp");
      await mk("blogcascade.com", "bcf");
      const pairsA = await loadBrandLandingPairs(tx, orgA);

      console.log("1. the 14 #362 cases — trigger vs app mirror:");
      for (const [url, want] of CASES) {
        const db_ = await tryInsert(tx, orgA, url);
        const app = validateBrandLpShape(url, pairsA) === null ? "A" : "R";
        check(`${want} ${url}`, db_ === want && app === want, `trigger=${db_} app=${app}`);
      }

      console.log("\n2. a brand added with its own host/path; then a host change:");
      const nb = await mk("newbrand.example", "nb");
      const nbUrl = "https://newbrand.example/nb/abc?sub_id3=T1";
      check("new brand's URL accepted by the trigger", (await tryInsert(tx, orgA, nbUrl)) === "A");
      await tx.execute(sql`UPDATE brands SET landing_host = 'newbrand2.example' WHERE id = ${nb}`);
      check("after the host change, the OLD host is refused (fresh insert)",
            (await tryInsert(tx, orgA, "https://newbrand.example/nb/def?sub_id3=T1")) === "R");
      // The mint upserts ON CONFLICT (org_id, url_hash) DO UPDATE SET url — the
      // re-mint of an already-stored old-host destination must be refused too.
      let upsertRefused = false;
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`
            INSERT INTO link_destinations (org_id, url, url_hash)
            SELECT org_id, url, url_hash FROM link_destinations
            WHERE org_id = ${orgA}::uuid AND url = ${nbUrl}
            ON CONFLICT (org_id, url_hash) DO UPDATE SET url = EXCLUDED.url
          `);
        });
      } catch (e) {
        upsertRefused = ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === "23514";
      }
      check("...and on the mint's ON CONFLICT DO UPDATE path", upsertRefused);
      check("the NEW host is accepted",
            (await tryInsert(tx, orgA, "https://newbrand2.example/nb/abc?sub_id3=T1")) === "A");
      check("unknown host on /lp/ refused", (await tryInsert(tx, orgA, "https://evil.example/lp/x?sub_id3=T1")) === "R");

      console.log("\n3. org isolation:");
      if (orgB) {
        const pairsB = await loadBrandLandingPairs(tx, orgB);
        const hasGk = pairsB.some((p) => p.host === "www.guidekn.com");
        check(`org B has no guidekn pair (${pairsB.length} pairs)`, !hasGk);
        check("org A's guidekn pair does not validate org B's URL",
              (await tryInsert(tx, orgB, "https://www.guidekn.com/lp/orv?sub_id3=T1")) === "R");
        check("org A's /nb/ path is not in org B's scope (no rule there)",
              (await tryInsert(tx, orgB, "https://whatever.example/nb/x?y=1")) === "A");
      } else {
        console.log("  SKIP  only one org on preview");
      }

      console.log("\n4. brand-save guards:");
      const taken = await checkBrandLandingPair(tx, { orgId: orgA, brandId: null, nextHost: "blogcascade.com", nextPath: "bcf" });
      check("pair already used by another brand ⇒ landing_pair_taken", taken?.code === LANDING_PAIR_TAKEN_CODE, JSON.stringify(taken));
      const self = await checkBrandLandingPair(tx, { orgId: orgA, brandId: nb, nextHost: "newbrand2.example", nextPath: "nb" });
      check("a brand re-saving its own pair is not 'taken'", self === null, JSON.stringify(self));
      // An external URL already using /mind/ on a host that is no brand's.
      check("seed external URL with /mind/", (await tryInsert(tx, orgA, "https://partner.example/mind/x?a=1")) === "A");
      const collide = await checkBrandLandingPair(tx, { orgId: orgA, brandId: null, nextHost: "fresh.example", nextPath: "mind" });
      const d = collide?.details as { count?: number; examples?: string[] } | undefined;
      check("new path that collides with an existing external URL ⇒ landing_path_collides",
            collide?.code === LANDING_PATH_COLLIDES_CODE && (d?.count ?? 0) >= 1, JSON.stringify(collide));
      check("...with the count and example URLs",
            (d?.examples ?? []).includes("https://partner.example/mind/x?a=1"), JSON.stringify(d?.examples));
      const ownHost = await checkBrandLandingPair(tx, { orgId: orgA, brandId: null, nextHost: "partner.example", nextPath: "mind" });
      check("a URL on the brand's OWN host is not a collision", ownHost === null, JSON.stringify(ownHost));
      const clean = await checkBrandLandingPair(tx, { orgId: orgA, brandId: null, nextHost: "fresh.example", nextPath: `zz${sfx.slice(-3)}` });
      check("a clean new path is accepted", clean === null, JSON.stringify(clean));
      const inScope = await checkBrandLandingPair(tx, { orgId: orgA, brandId: null, nextHost: "fresh.example", nextPath: "bcf" });
      check("a path already in scope (bcf) is not collision-checked", inScope === null, JSON.stringify(inScope));

      console.log("\n5. unique (org, host, path) backstop:");
      let dupCode = "";
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`
            INSERT INTO brands (org_id, brand_id, name, landing_host, landing_path)
            VALUES (${orgA}::uuid, ${`t212-dup-${sfx}`}, 'dup', 'blogcascade.com', 'bcf')
          `);
        });
      } catch (e) {
        dupCode = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? "";
      }
      check("duplicate pair ⇒ 23505", dupCode === "23505", dupCode);

      const impact = await computeBrandLandingImpact(tx, { orgId: orgA, brandId: nb });
      check("impact count runs (fixture brand ⇒ 0/0)", impact.campaigns === 0 && impact.stages === 0, JSON.stringify(impact));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const destAfter = (await db.execute(sql`SELECT count(*)::int AS n FROM link_destinations`)) as unknown as { n: number }[];
  const brandsAfter = (await db.execute(sql`SELECT count(*)::int AS n FROM brands`)) as unknown as { n: number }[];
  check(`no residue: link_destinations ${destBefore[0].n} → ${destAfter[0].n}, brands ${brandsBefore[0].n} → ${brandsAfter[0].n}`,
        destAfter[0].n === destBefore[0].n && brandsAfter[0].n === brandsBefore[0].n);

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
