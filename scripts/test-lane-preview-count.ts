// Verifies the LIVE lane preview COUNT the stages list shows for behavioral
// lanes — i.e. countStageRecipients() (which wraps the step-3 stageRecipientsSql).
// The stages-list audience_count routes lane rows through this exact function,
// so testing it validates the number the operator sees in the UI.
//
// TEST-DATA SAFETY: seeded under a dedicated throwaway org (marker below).
// Teardown scoped to that org_id only (marker-guarded). Real-data table counts
// captured before and re-checked after.
//
// Run: npx tsx scripts/test-lane-preview-count.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { LANE_TIER_VALUES } from "@/lib/campaign-tier";
import { countStageRecipients } from "@/lib/sends/recipients";

import { seedConversionEvent } from "./_conversion-fixture";

// ⚠️ `.env.local` is PRODUCTION and `_env-preload` loads it whenever
// DATABASE_URL is not already set. This script WRITES fixtures, so refuse
// outright rather than trust the caller's environment:
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-lane-preview-count.ts
// The refusal itself is the `_require-preview-db` import above — an allowlist,
// and early enough that nothing can query ahead of it.

const ORG_MARKER = "__LANE_PREVIEW_TEST__";
const COUNTED_TABLES = [
  "organizations", "brands", "contacts", "campaigns", "campaign_stages",
  "campaign_audience_pool", "stage_sends", "links", "clicks", "opt_outs",
  "short_domains", "link_destinations", "conversion_events", "event_types",
] as const;

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
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
        sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`,
      )) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }

  const unique = Date.now();
  let orgId = "";
  const cid: Record<string, string> = {};

  // The exact path the list route uses for a lane row.
  function laneCount(campaignId: number, parentStageId: number, tier: number) {
    return countStageRecipients(db, {
      campaignId,
      orgId,
      filters: {
        includeNoStatus: true,
        includeClickers: true,
        excludeClickers: false,
        splitIndex: null,
        splitTotal: null,
        behavioralTier: tier,
        parentStageId,
      },
    });
  }
  function ordinaryCount(campaignId: number) {
    return countStageRecipients(db, {
      campaignId,
      orgId,
      filters: {
        includeNoStatus: true,
        includeClickers: false,
        excludeClickers: false,
        splitIndex: null,
        splitTotal: null,
      },
    });
  }

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    orgId = (
      (await db.execute(sql`
        INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[]
    )[0].id;
    // migration 0181's event_types seed is a one-time backfill over orgs that
    // existed at migration time — a brand-new org (like this throwaway one)
    // gets none automatically, so seedConversionEvent's key lookup would throw.
    // Mirror that backfill for this org; it cascades away with it on teardown.
    await db.execute(sql`
      INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
      VALUES
        (${orgId}::uuid, 'purchase', 'Purchase', 10, true, true, false),
        (${orgId}::uuid, 'registration', 'Registration', 20, false, false, true)
      ON CONFLICT (org_id, key) DO NOTHING
    `);

    const brandId = (
      (await db.execute(sql`
        INSERT INTO brands (org_id, brand_id, name)
        VALUES (${orgId}::uuid, ${`LP-${unique}`}, ${`LanePrev ${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const shortDomainId = (
      (await db.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain)
        VALUES (${orgId}::uuid, ${brandId}::int, ${`lp-${unique}.test`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;
    const destId = (
      (await db.execute(sql`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${orgId}::uuid, ${"https://example.test/o"}, ${`h-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[]
    )[0].id;

    async function seedCampaignStage(suffix: string) {
      const campaignId = (
        (await db.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, brand_id)
          VALUES (${orgId}::uuid, ${`lp-${suffix}-${unique}`}, ${`LanePrev ${suffix}`}, ${brandId}::int)
          RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      const stageId = (
        (await db.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
          VALUES (${orgId}::uuid, ${campaignId}::int, 1)
          RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      return { campaignId, stageId };
    }

    // ---- Campaign A: full scenario (mirrors step 3). ----
    const A = await seedCampaignStage("a");
    const roles = ["ign", "clk", "rch", "cnv", "reg", "opt", "nal"];
    for (const role of roles) {
      const phone = `+1998${String(unique).slice(-6)}${roles.indexOf(role)}`;
      cid[role] = (
        (await db.execute(sql`
          INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
          VALUES (${orgId}::uuid, ${phone}, now(), now())
          RETURNING id::text AS id
        `)) as unknown as { id: string }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
           was_opt_in_at_snapshot, was_no_status_at_snapshot)
        VALUES (${A.campaignId}::int, ${cid[role]}::uuid, ${orgId}::uuid, false, false, true)
      `);
    }
    async function received(campaignId: number, stageId: number, role: string, reached: boolean, sale: boolean) {
      const sendRows = (await db.execute(sql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
           sale_status, offer_reached_at, offer_reach_event_id)
        VALUES (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${cid[role]}::uuid,
                ${"x"}, ${"b"}, ${"sent"}, ${sale ? "sale" : null},
                ${reached ? sql`now()` : sql`NULL`}, ${reached ? `e-${role}` : null})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      if (sale) {
        await seedConversionEvent(db, {
          orgId,
          stageSendId: sendRows[0].id,
          contactId: cid[role],
          campaignId,
          stageId,
          eventKey: "purchase",
          status: "approved",
          revenue: 100,
          keitaroType: "sale",
        });
      }
    }
    let codeSeq = 0;
    async function cleanClick(campaignId: number, stageId: number, role: string) {
      codeSeq += 1;
      const link = (
        (await db.execute(sql`
          INSERT INTO links
            (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
             contact_id, send_token, campaign_tracking_id, stage_tracking_id)
          VALUES (${orgId}::uuid, ${`lp-${unique}-${codeSeq}`}, ${shortDomainId}::int,
                  ${destId}::int, ${campaignId}::int, ${stageId}::int, ${cid[role]}::uuid,
                  ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
          RETURNING id
        `)) as unknown as { id: number }[]
      )[0].id;
      await db.execute(sql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${orgId}::uuid, ${link}::bigint, ${"human"})
      `);
    }

    await received(A.campaignId, A.stageId, "ign", false, false);
    await received(A.campaignId, A.stageId, "clk", false, false);
    await received(A.campaignId, A.stageId, "rch", true, false);
    await received(A.campaignId, A.stageId, "cnv", true, true);
    // reg: reached the offer AND registered → tier 3. ONE-SIDED — `received(...,
    // false)` leaves sale_status NULL, so the Registered lane's count cannot come
    // from the legacy column.
    await received(A.campaignId, A.stageId, "reg", true, false);
    await seedConversionEvent(db, {
      orgId,
      contactId: cid.reg,
      campaignId: A.campaignId,
      stageId: A.stageId,
      eventKey: "registration",
      status: "approved",
      revenue: 0,
    });
    await received(A.campaignId, A.stageId, "opt", false, false);
    // nal: no parent send (not alive)
    await cleanClick(A.campaignId, A.stageId, "clk");
    await cleanClick(A.campaignId, A.stageId, "rch");
    await cleanClick(A.campaignId, A.stageId, "opt");
    await cleanClick(A.campaignId, A.stageId, "nal");
    await db.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source, reason)
      VALUES (${orgId}::uuid, ${cid.opt}::uuid,
              (SELECT phone_number FROM contacts WHERE id = ${cid.opt}::uuid), ${"t"}, ${"opt_out"})
    `);

    console.log("\nLive lane preview counts (campaign A):");
    check("ordinary stage count = 6 (pool − opt-out)", (await ordinaryCount(A.campaignId)) === 6);
    // One expected count per lane tier, read through a helper that THROWS on a
    // tier it has no entry for — a tier joining LANE_TIER_VALUES must be seeded
    // here, not silently skipped or compared against a default.
    const expectedLane: Record<number, { label: string; n: number }> = {
      0: { label: "Ignored", n: 1 },
      1: { label: "Clicked", n: 1 },
      2: { label: "Reached", n: 1 },
      3: { label: "Registered", n: 1 },
    };
    const expectLane = (tier: number) => {
      const e = expectedLane[tier];
      if (!e) {
        throw new Error(`lane tier ${tier} is in LANE_TIER_VALUES but this fixture seeds no count for it`);
      }
      return e;
    };
    // ⭐ PIN THE THROW. It is unreachable today — every tier in LANE_TIER_VALUES
    // has a row in `expectedLane` — and an unreachable throw is not a working
    // one. Its whole job is to make a future scale addition LOUD instead of
    // letting the tier compare against `undefined`, so prove it fires.
    let unmappedThrew = false;
    try {
      expectLane(-1);
    } catch {
      unmappedThrew = true;
    }
    check("⭐ a tier with no seeded count THROWS (not silently skipped)", unmappedThrew);
    let sum = 0;
    for (const tier of LANE_TIER_VALUES) {
      const e = expectLane(tier);
      const n = await laneCount(A.campaignId, A.stageId, tier);
      sum += n;
      check(`tier-${tier} (${e.label}) lane = ${e.n}`, n === e.n, `got ${n}`);
    }
    // Every lane + purchased(1) + opted-out(1) = 6 received-parent. The expected
    // sum is derived from the same table the per-lane bars use, so it cannot
    // drift away from them.
    const expectedSum = LANE_TIER_VALUES.reduce((a, t) => a + expectLane(t).n, 0);
    check(
      `lane counts sum to ${expectedSum} (purchased + opted-out NOT counted)`,
      sum === expectedSum,
      `got ${sum}`,
    );

    // ---- Campaign B: ZERO-DATA — pool exists, but NO sends fired. ----
    // Mirrors production today: with no sends, nobody is "alive", so every lane
    // previews 0. Confirms the count is a clean 0 (the UI renders "0 live").
    const B = await seedCampaignStage("b");
    const bPhone = `+1997${String(unique).slice(-6)}0`;
    const bContact = (
      (await db.execute(sql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${bPhone}, now(), now())
        RETURNING id::text AS id
      `)) as unknown as { id: string }[]
    )[0].id;
    cid.bOnly = bContact;
    await db.execute(sql`
      INSERT INTO campaign_audience_pool
        (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
         was_opt_in_at_snapshot, was_no_status_at_snapshot)
      VALUES (${B.campaignId}::int, ${bContact}::uuid, ${orgId}::uuid, false, false, true)
    `);

    console.log("\nZero-data (campaign B — pool present, no sends fired):");
    check("ordinary count = 1 (pool present)", (await ordinaryCount(B.campaignId)) === 1);
    // Every lane, derived. These are "== 0" bars, but NOT of an empty world: bar
    // above pins the pool at 1, so the 0s mean "present in the pool, not alive",
    // and the campaign-A block proves the same helper returns non-zero when a
    // contact IS alive.
    for (const tier of LANE_TIER_VALUES) {
      const n = await laneCount(B.campaignId, B.stageId, tier);
      check(`tier-${tier} lane = 0 (no one alive — no parent sends)`, n === 0, `got ${n}`);
    }
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const name =
          (
            (await db.execute(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[]
          )[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM link_destinations WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM short_domains WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM opt_outs WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM brands WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
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
      await pgConn.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
