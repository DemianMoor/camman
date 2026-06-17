import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { randomUUID } from "node:crypto";

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { stageRecipientsSql, type StageRecipientFilters } from "../lib/sends/recipients";

// Integration test for the behavioral-lane overlays in stageRecipientsSql().
//
// TEST-DATA SAFETY: every row is seeded under a DEDICATED throwaway organization
// whose name carries the marker below. Teardown is scoped to that org_id ONLY
// (asserted to match the marker first) — never a broad phone/name prefix. Real-
// data table counts are captured before seeding and re-checked after teardown.
const ORG_MARKER = "__TIER_LANE_TEST__";

// Tables we snapshot to prove real data is untouched.
const COUNTED_TABLES = [
  "organizations", "brands", "contacts", "campaigns", "campaign_stages",
  "campaign_audience_pool", "stage_sends", "links", "clicks", "opt_outs",
  "short_domains", "link_destinations",
] as const;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM ${drizzleSql.raw(t)}`,
      )) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }

  const unique = Date.now();
  let testOrgId = "";

  // Map role → contact_id.
  const cid: Record<string, string> = {};

  async function lane(
    campaignId: number,
    parentStageId: number,
    tier: number,
  ): Promise<Set<string>> {
    return recipients(campaignId, {
      includeNoStatus: true,
      includeClickers: true,
      excludeClickers: false,
      splitIndex: null,
      splitTotal: null,
      behavioralTier: tier,
      parentStageId,
    });
  }
  async function recipients(
    campaignId: number,
    filters: StageRecipientFilters,
  ): Promise<Set<string>> {
    const rows = (await db.execute(
      stageRecipientsSql({ campaignId, orgId: testOrgId, filters }),
    )) as unknown as { contact_id: string }[];
    return new Set(rows.map((r) => r.contact_id));
  }
  const roleOf = (set: Set<string>) =>
    Object.entries(cid)
      .filter(([, id]) => set.has(id))
      .map(([role]) => role)
      .sort();

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    // --- Dedicated throwaway org. ---
    const orgRows = (await db.execute(drizzleSql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    testOrgId = orgRows[0].id;

    // --- FK deps for links: brand → short_domain, + link_destination. ---
    const brandRows = (await db.execute(drizzleSql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${testOrgId}::uuid, ${`TL-${unique}`}, ${`TierLane Brand ${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    const brandId = brandRows[0].id;
    const sdRows = (await db.execute(drizzleSql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${testOrgId}::uuid, ${brandId}::int, ${`tl-${unique}.test`})
      RETURNING id
    `)) as unknown as { id: number }[];
    const shortDomainId = sdRows[0].id;
    const destRows = (await db.execute(drizzleSql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${testOrgId}::uuid, ${"https://example.test/o"}, ${`h-${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    const destId = destRows[0].id;

    // --- Campaign + parent stage. ---
    const campRows = (await db.execute(drizzleSql`
      INSERT INTO campaigns (org_id, slug, name, brand_id)
      VALUES (${testOrgId}::uuid, ${`tl-${unique}`}, ${"TierLane Camp"}, ${brandId}::int)
      RETURNING id
    `)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;
    const stageRows = (await db.execute(drizzleSql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
      VALUES (${testOrgId}::uuid, ${campaignId}::int, 1)
      RETURNING id
    `)) as unknown as { id: number }[];
    const parentStageId = stageRows[0].id;

    // --- Contacts: one per scenario. ---
    const roles = ["ign", "clk", "rch", "cnv", "opt", "nal"];
    for (const role of roles) {
      const phone = `+1999${String(unique).slice(-6)}${roles.indexOf(role)}`;
      const r = (await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${testOrgId}::uuid, ${phone}, now(), now())
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      cid[role] = r[0].id;
    }

    // --- Frozen pool: ALL six, all no_status so the base status-filter passes
    //     everyone — isolating the behavioral overlays from snapshot filters. ---
    for (const role of roles) {
      await db.execute(drizzleSql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${campaignId}::int, ${cid[role]}::uuid, ${testOrgId}::uuid,
                false, false, true)
      `);
    }

    // --- Seed helpers. ---
    async function received(role: string, reached: boolean, sale: boolean) {
      await db.execute(drizzleSql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
           status, sale_status, offer_reached_at, offer_reach_event_id)
        VALUES
          (${testOrgId}::uuid, ${campaignId}::int, ${parentStageId}::int,
           ${cid[role]}::uuid, ${"x"}, ${"body"}, ${"sent"},
           ${sale ? "sale" : null},
           ${reached ? drizzleSql`now()` : drizzleSql`NULL`},
           ${reached ? `evt-${role}` : null})
      `);
    }
    let codeSeq = 0;
    async function cleanClick(role: string) {
      codeSeq += 1;
      const link = (await db.execute(drizzleSql`
        INSERT INTO links
          (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES
          (${testOrgId}::uuid, ${`tl-${unique}-${codeSeq}`}, ${shortDomainId}::int,
           ${destId}::int, ${campaignId}::int, ${parentStageId}::int,
           ${cid[role]}::uuid, ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[];
      await db.execute(drizzleSql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${testOrgId}::uuid, ${link[0].id}::bigint, ${"human"})
      `);
    }

    // --- Apply scenarios ---
    // received parent (alive) for everyone EXCEPT nal:
    await received("ign", false, false); // tier 0
    await received("clk", false, false); // tier 1 (click below)
    await received("rch", true, false); // tier 2 (reached) + click below → climbs past 1
    await received("cnv", true, true); // tier 3 (reached + sale)
    await received("opt", false, false); // tier 1 (click below) but opted out
    // nal: NO stage_sends row → not alive (but has a click → tier 1)
    await cleanClick("clk");
    await cleanClick("rch");
    await cleanClick("opt");
    await cleanClick("nal");
    // opt-out for opt
    await db.execute(drizzleSql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source, reason)
      VALUES (${testOrgId}::uuid, ${cid.opt}::uuid,
              (SELECT phone_number FROM contacts WHERE id = ${cid.opt}::uuid),
              ${"test"}, ${"opt_out"})
    `);

    // ====================================================================
    // 1) ORDINARY stage — driven by snapshot + opt_out only, behavior ignored.
    //    All six are no_status (pass), opt is opted out → {ign,clk,rch,cnv,nal}.
    // ====================================================================
    console.log("\nOrdinary (non-lane) stage:");
    const ord = await recipients(campaignId, {
      includeNoStatus: true,
      includeClickers: false,
      excludeClickers: false,
      splitIndex: null,
      splitTotal: null,
    });
    check(
      "ordinary returns pool minus opt-outs (same as today): {ign,clk,rch,cnv,nal}",
      JSON.stringify(roleOf(ord)) ===
        JSON.stringify(["clk", "cnv", "ign", "nal", "rch"]),
      roleOf(ord).join(","),
    );

    // ====================================================================
    // 2-8) Lanes
    // ====================================================================
    const lane0 = await lane(campaignId, parentStageId, 0);
    const lane1 = await lane(campaignId, parentStageId, 1);
    const lane2 = await lane(campaignId, parentStageId, 2);

    console.log("\nLanes off the parent:");
    check("tier-0 lane = {ign} (alive, no signal)", JSON.stringify(roleOf(lane0)) === JSON.stringify(["ign"]), roleOf(lane0).join(","));
    check("tier-1 lane = {clk} (alive clicker, not opted out)", JSON.stringify(roleOf(lane1)) === JSON.stringify(["clk"]), roleOf(lane1).join(","));
    check("tier-2 lane = {rch} (climbed past click)", JSON.stringify(roleOf(lane2)) === JSON.stringify(["rch"]), roleOf(lane2).join(","));

    check(
      "cross-lane climb: rch in tier-2, NOT in tier-1",
      lane2.has(cid.rch) && !lane1.has(cid.rch),
    );
    check(
      "converted (tier 3) contact in NO lane (0/1/2)",
      !lane0.has(cid.cnv) && !lane1.has(cid.cnv) && !lane2.has(cid.cnv),
    );
    check(
      "opted-out contact in NO lane (even though tier 1)",
      !lane0.has(cid.opt) && !lane1.has(cid.opt) && !lane2.has(cid.opt),
    );
    check(
      "not-alive contact (no parent send) in NO lane (even though tier 1)",
      !lane0.has(cid.nal) && !lane1.has(cid.nal) && !lane2.has(cid.nal),
    );

    // ====================================================================
    // 9) Mutual exclusivity + accounting over the alive population.
    // ====================================================================
    console.log("\nPartition / accounting:");
    const inter = (a: Set<string>, b: Set<string>) =>
      [...a].filter((x) => b.has(x));
    check(
      "lanes pairwise disjoint",
      inter(lane0, lane1).length === 0 &&
        inter(lane0, lane2).length === 0 &&
        inter(lane1, lane2).length === 0,
    );
    // Alive-and-not-opted-out = {ign,clk,rch,cnv}. Lanes(0,1,2) ∪ converted{cnv}
    // must equal it exactly — no double-count, no loss.
    const union012 = new Set([...lane0, ...lane1, ...lane2]);
    const partitioned = new Set([...union012, cid.cnv]);
    const aliveNotOpted = new Set([cid.ign, cid.clk, cid.rch, cid.cnv]);
    const sameSet =
      partitioned.size === aliveNotOpted.size &&
      [...aliveNotOpted].every((x) => partitioned.has(x));
    check(
      "lanes ∪ {converted} == alive-and-not-opted-out (no double, no loss)",
      sameSet && union012.size === 3,
      `union012=${roleOf(union012).join(",")}`,
    );
    check(
      "opted-out + not-alive excluded from the partition entirely",
      !partitioned.has(cid.opt) && !partitioned.has(cid.nal),
    );
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (testOrgId) {
        // Safety: refuse to delete unless this really is the marked test org.
        const nameRows = (await db.execute(drizzleSql`
          SELECT name FROM organizations WHERE id = ${testOrgId}::uuid
        `)) as unknown as { name: string }[];
        const name = nameRows[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(
            `Refusing teardown: org ${testOrgId} name "${name}" is not the test marker.`,
          );
        }
        // Dependency order, all scoped to testOrgId. Deleting campaigns cascades
        // stages, pool, stage_sends, links (→ clicks). Then unref'd FK targets.
        await db.execute(drizzleSql`DELETE FROM campaigns WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM link_destinations WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM short_domains WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM opt_outs WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM contacts WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM brands WHERE org_id = ${testOrgId}::uuid`);
        await db.execute(drizzleSql`DELETE FROM organizations WHERE id = ${testOrgId}::uuid`);
        console.log("  cleanup complete");
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) {
        if (before[t] !== after[t]) {
          drift = true;
          console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: before=${before[t]} after=${after[t]}`);
        }
      }
      check("real-data table counts unchanged after teardown", !drift);
      await pg.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
