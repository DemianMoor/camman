import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// ⚠️ This script INSERTS fixtures (brands, campaigns, contacts, clicks, ledger
// rows) and deletes them again — it is NOT transaction-wrapped. `.env.local` is
// PRODUCTION, and dotenv above loads it whenever DATABASE_URL is not already
// set, so the refusal is not optional. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-campaign-tier.ts
// The refusal itself is the `_require-preview-db` import at the top — an
// allowlist, and ahead of the dotenv load, so an unset DATABASE_URL is refused
// rather than quietly resolved to `.env.local` (i.e. production).

import { randomUUID } from "node:crypto";

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  campaignTierExpr,
  EXIT_TIER,
  TIER_CLICKED,
  TIER_REGISTERED,
} from "../lib/campaign-tier";
import { seedConversionEvent } from "./_conversion-fixture";

// Unit test for campaignTierExpr() against SEEDED synthetic data — the live
// click/send tables are empty, so every signal here is created by this script
// and torn down at the end. No API, no auth: seed → run the real fragment →
// assert → delete everything created.
//
// ── THE SCALE THIS FILE ASSERTS (Phase 4, migration 0184) ───────────────────
//   0 ignored · 1 clicked · 2 reached offer · 3 REGISTERED · 4 PURCHASED (exit)
// Registered is the new tier and the purchased EXIT moved from 3 to 4, so that
// MAX(tier) still ranks a buyer above a registrant. Assertions below name
// `EXIT_TIER` / `TIER_REGISTERED` rather than the digit, so the scale can move
// again without leaving this suite green by accident.
//
// Covers: no activity → 0; clicked → 1; clicked+reached → 2 (high-water);
// reached + counted purchase → EXIT_TIER; dirty (bot/prefetch/suspect) click
// only → 0; activity in a DIFFERENT campaign → 0 here (scoping); clicked here +
// sale elsewhere → 1 here. Plus: an 'unknown'-classification click counts as
// clean (→ 1), and the cross-campaign contacts read their real tier in the
// OTHER campaign.
//
// ⭐ AND SIX CONTROLS THAT TELL THE LEDGER READER FROM THE OLD ONE, AND THE
// REGISTERED BRANCH FROM THE PURCHASED ONE. The exit tier comes from
// conversion_events, not stage_sends.sale_status. A fixture that writes BOTH on
// the same contact reads the same under either source, so it proves nothing
// about the switch. Each of these writes exactly ONE side:
//   ledger_only_pending  — ledger purchase (pending), sale_status NULL  → 4
//   legacy_only          — sale_status 'lead' + converted_at, no ledger → 0
//   rejected_ledger      — ledger purchase status 'rejected'            → 0
//   registration_ledger  — ledger registration + a legacy 'lead' row    → 3
//   registered_only      — ledger registration, nothing else            → 3
//   registered_rejected  — registration + a REJECTED purchase           → NOT 3
// `registration_ledger` is the bug that motivated the whole phase: a $0
// registration arriving as a 'lead' postback used to make the contact a
// converted buyer. It is two-sided by construction, so `legacy_only` is the
// one-sided control that keeps "the legacy column is not read" provable.

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

  const unique = Date.now();
  const phonePrefix = `+1213999${String(unique).slice(-4)}`;
  const insertedPhones: string[] = [];
  const createdCampaignIds: number[] = [];
  let orgId = "";
  let brandId = 0;
  let shortDomainId = 0;
  let destId = 0;

  // contact_id by role label
  const cid: Record<string, string> = {};

  // Resolve current tier of one contact in one campaign via the REAL fragment.
  // Absent from the fragment's output ⇒ COALESCE to 0 (ignored), exactly how
  // callers will read it.
  async function tierFor(campaignId: number, contactId: string): Promise<number> {
    const rows = (await db.execute(drizzleSql`
      SELECT COALESCE((
        SELECT t.tier
        FROM (${campaignTierExpr(campaignId, orgId)}) t
        WHERE t.contact_id = ${contactId}::uuid
      ), 0)::int AS tier
    `)) as unknown as { tier: number }[];
    return Number(rows[0]?.tier ?? -1);
  }

  try {
    // --- Org: reuse any existing organization (FK target only). ---
    const orgRows = (await db.execute(drizzleSql`
      SELECT id::text AS id FROM organizations ORDER BY created_at ASC LIMIT 1
    `)) as unknown as { id: string }[];
    if (!orgRows[0]) {
      throw new Error("No organization exists to attach test fixtures to.");
    }
    orgId = orgRows[0].id;

    // --- Brand + short domain + link destination (FK deps for `links`). ---
    const brandRows = (await db.execute(drizzleSql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${orgId}::uuid, ${`TIER-${unique}`}, ${`Tier Test Brand ${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    brandId = brandRows[0].id;

    const sdRows = (await db.execute(drizzleSql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${orgId}::uuid, ${brandId}::int, ${`tier-${unique}.test`})
      RETURNING id
    `)) as unknown as { id: number }[];
    shortDomainId = sdRows[0].id;

    const destRows = (await db.execute(drizzleSql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${orgId}::uuid, ${"https://example.test/offer"}, ${`hash-${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    destId = destRows[0].id;

    // --- Two campaigns, each with one stage. A = "this campaign", B = "other". ---
    async function seedCampaignStage(suffix: string) {
      const camp = (await db.execute(drizzleSql`
        INSERT INTO campaigns (org_id, slug, name, brand_id)
        VALUES (${orgId}::uuid, ${`tier-${suffix}-${unique}`}, ${`Tier Camp ${suffix}`}, ${brandId}::int)
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;
      createdCampaignIds.push(campaignId);
      const stage = (await db.execute(drizzleSql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
        VALUES (${orgId}::uuid, ${campaignId}::int, 1)
        RETURNING id
      `)) as unknown as { id: number }[];
      return { campaignId, stageId: stage[0].id };
    }
    const campA = await seedCampaignStage("a");
    const campB = await seedCampaignStage("b");

    // --- Contacts (one per behavioral scenario). ---
    const roles = [
      "none", // no activity → 0
      "clicked", // clean click in A → 1
      "clicked_unknown", // 'unknown'-class click in A → 1 (clean)
      "clicked_reached", // clean click + reached in A → 2
      "reached_sale", // reached + sale in A → 4 (the exit)
      "dirty_only", // bot/prefetch/suspect clicks in A → 0
      "click_here_sale_b", // clean click in A + sale in B → 1 here / 4 in B
      "other_campaign", // reached + sale in B only → 0 in A / 4 in B
      // ⭐ the source controls (see the header note)
      "ledger_only_pending", // ledger purchase (pending), sale_status NULL → 4
      "legacy_only", // sale_status 'lead' + converted_at, NO ledger row → 0
      "rejected_ledger", // ledger purchase, status 'rejected' → 0
      "registration_ledger", // ledger registration + a legacy 'lead' row → 3
      // ⭐ PHASE 4 CONTROLS. One-sided: a registration ledger row and nothing
      // else, so neither bar can be satisfied by the legacy column.
      "registered_only", // registration, no purchase → 3
      "registered_rejected", // registration + REJECTED purchase → NOT 3
    ];
    for (const role of roles) {
      const phone = `${phonePrefix}${roles.indexOf(role)}`;
      insertedPhones.push(phone);
      const rows = (await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${phone}, now(), now())
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      cid[role] = rows[0].id;
    }

    // --- Seed helpers. ---
    let codeSeq = 0;
    async function seedClick(
      campaignId: number,
      stageId: number,
      contactId: string,
      classification: string,
    ) {
      codeSeq += 1;
      const linkRows = (await db.execute(drizzleSql`
        INSERT INTO links
          (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES
          (${orgId}::uuid, ${`tt-${unique}-${codeSeq}`}, ${shortDomainId}::int,
           ${destId}::int, ${campaignId}::int, ${stageId}::int, ${contactId}::uuid,
           ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[];
      await db.execute(drizzleSql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${orgId}::uuid, ${linkRows[0].id}::bigint, ${classification})
      `);
    }
    type LedgerSpec = {
      eventKey: "purchase" | "registration";
      status: "pending" | "approved" | "rejected";
    } | null;
    async function seedSend(
      campaignId: number,
      stageId: number,
      contactId: string,
      reached: boolean,
      saleStatus: string | null,
      // ⭐ SEPARATE from saleStatus on purpose. `undefined` keeps the realistic
      // pairing (a paid 'lead'/'sale' postback also lands an approved purchase
      // in the ledger); passing it EXPLICITLY lets a control write the ledger
      // without the legacy column, or the legacy column without the ledger —
      // which is the only way a fixture can tell the two sources apart.
      ledger?: LedgerSpec,
    ) {
      const legacyPaid = saleStatus === "lead" || saleStatus === "sale";
      const sendRows = (await db.execute(drizzleSql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
           sale_status, sale_revenue, converted_at, offer_reached_at, offer_reach_event_id)
        VALUES
          (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${contactId}::uuid,
           ${"x"}, ${"test body"}, ${"sent"}, ${saleStatus},
           ${saleStatus === null ? null : "100.0000"}::numeric,
           ${saleStatus === null ? drizzleSql`NULL` : drizzleSql`now()`},
           ${reached ? drizzleSql`now()` : drizzleSql`NULL`},
           ${reached ? `evt-${contactId}` : null})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      // Tier 3 is read off the conversion_events ledger now, so a purchase has
      // to be seeded there. The legacy column is still written above because the
      // projection keeps it (lib/keitaro/poll-conversions.ts).
      const spec: LedgerSpec =
        ledger === undefined
          ? legacyPaid
            ? { eventKey: "purchase", status: "approved" }
            : null
          : ledger;
      if (spec) {
        await seedConversionEvent(db, {
          orgId,
          stageSendId: sendRows[0].id,
          contactId,
          campaignId,
          stageId,
          eventKey: spec.eventKey,
          status: spec.status,
          revenue: spec.eventKey === "registration" ? 0 : 100,
          keitaroType: legacyPaid ? (saleStatus as string) : undefined,
        });
      }
    }

    // --- Apply signals. ---
    await seedClick(campA.campaignId, campA.stageId, cid.clicked, "human");
    await seedClick(campA.campaignId, campA.stageId, cid.clicked_unknown, "unknown");
    await seedClick(campA.campaignId, campA.stageId, cid.clicked_reached, "human");
    await seedSend(campA.campaignId, campA.stageId, cid.clicked_reached, true, null);
    await seedSend(campA.campaignId, campA.stageId, cid.reached_sale, true, "sale");
    // dirty_only: one of each excluded classification, no clean click → still 0.
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "bot");
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "prefetch");
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "suspect");
    // click here, sale in B.
    await seedClick(campA.campaignId, campA.stageId, cid.click_here_sale_b, "human");
    await seedSend(campB.campaignId, campB.stageId, cid.click_here_sale_b, false, "sale");
    // other_campaign: reached + sale in B only.
    await seedSend(campB.campaignId, campB.stageId, cid.other_campaign, true, "sale");

    // ⭐ the four one-sided controls, all in campaign A, none of them reached.
    await seedSend(campA.campaignId, campA.stageId, cid.ledger_only_pending, false, null, {
      eventKey: "purchase",
      status: "pending",
    });
    await seedSend(campA.campaignId, campA.stageId, cid.legacy_only, false, "lead", null);
    await seedSend(campA.campaignId, campA.stageId, cid.rejected_ledger, false, null, {
      eventKey: "purchase",
      status: "rejected",
    });
    await seedSend(campA.campaignId, campA.stageId, cid.registration_ledger, false, "lead", {
      eventKey: "registration",
      status: "approved",
    });

    // ⭐ PHASE 4 CONTROLS, both ONE-SIDED (sale_status stays NULL on both).
    //
    // `registered_rejected` also gets a clean CLICK, so the bar can assert where
    // the eviction lands instead of merely "not 3": with no other signal the
    // contact would read 0, which a contact with no fixture at all also reads —
    // the assertion would then pass for a contact this script never seeded.
    await seedSend(campA.campaignId, campA.stageId, cid.registered_only, false, null, {
      eventKey: "registration",
      status: "approved",
    });
    await seedClick(campA.campaignId, campA.stageId, cid.registered_rejected, "human");
    await seedSend(campA.campaignId, campA.stageId, cid.registered_rejected, false, null, {
      eventKey: "registration",
      status: "approved",
    });
    // The second ledger row for the same contact. Both tier branches scope on
    // conversion_events.campaign_id + contact_id (never through stage_sends), so
    // this row needs no send of its own — and the cleanup below finds it by
    // campaign_id like every other fixture row.
    await seedConversionEvent(db, {
      orgId,
      contactId: cid.registered_rejected,
      campaignId: campA.campaignId,
      stageId: campA.stageId,
      eventKey: "purchase",
      status: "rejected",
      revenue: 0,
    });

    // ====================================================================
    // ASSERTIONS — campaign A (this campaign)
    // ====================================================================
    console.log("\nCampaign A (this campaign):");
    check("no activity → 0", (await tierFor(campA.campaignId, cid.none)) === 0);
    check("clean click only → 1", (await tierFor(campA.campaignId, cid.clicked)) === 1);
    check(
      "'unknown'-class click counts as clean → 1",
      (await tierFor(campA.campaignId, cid.clicked_unknown)) === 1,
    );
    check(
      "clicked + reached → 2 (high-water, not 1)",
      (await tierFor(campA.campaignId, cid.clicked_reached)) === 2,
    );
    check(
      `reached + counted purchase ⇒ ${EXIT_TIER} (the exit)`,
      (await tierFor(campA.campaignId, cid.reached_sale)) === EXIT_TIER,
      `got ${await tierFor(campA.campaignId, cid.reached_sale)}`,
    );
    check(
      "bot/prefetch/suspect click only → 0 (not counted as clicked)",
      (await tierFor(campA.campaignId, cid.dirty_only)) === 0,
    );
    check(
      "activity in a DIFFERENT campaign → 0 here (scoping)",
      (await tierFor(campA.campaignId, cid.other_campaign)) === 0,
    );
    check(
      `clicked here + purchase elsewhere ⇒ 1 here, not ${EXIT_TIER}`,
      (await tierFor(campA.campaignId, cid.click_here_sale_b)) === TIER_CLICKED,
    );

    // ====================================================================
    // ⭐ SOURCE CONTROLS — these are the bars that go red if tier 3 is read
    // off stage_sends.sale_status instead of the conversion_events ledger.
    // ====================================================================
    console.log("\nCampaign A — ledger vs legacy source controls:");
    check(
      `⭐ LEDGER-ONLY purchase (pending, sale_status NULL) → ${EXIT_TIER}`,
      (await tierFor(campA.campaignId, cid.ledger_only_pending)) === EXIT_TIER,
      `got ${await tierFor(campA.campaignId, cid.ledger_only_pending)}`,
    );
    // The ONE-SIDED half of the registration control below: same legacy column,
    // no ledger row at all. It is what keeps "the legacy column is not read"
    // provable now that its two-sided sibling expects a non-zero tier.
    check(
      "⭐ LEGACY-ONLY 'lead' row, no ledger row at all → 0 — the legacy column is still not read",
      (await tierFor(campA.campaignId, cid.legacy_only)) === 0,
      `got ${await tierFor(campA.campaignId, cid.legacy_only)}`,
    );
    check(
      "⭐ REJECTED ledger purchase → 0 (a refund is not a purchase)",
      (await tierFor(campA.campaignId, cid.rejected_ledger)) === 0,
      `got ${await tierFor(campA.campaignId, cid.rejected_ledger)}`,
    );
    // Phase 3's point here was that the legacy sale_status column is NOT read.
    // Phase 4's is that a registration is its own tier. One bar can no longer
    // carry both, because THIS fixture writes BOTH sides — a registration ledger
    // row AND a legacy 'lead' row on the same contact — so once the expectation
    // flips off 0 it can no longer tell the new tier-3 branch from the old
    // legacy reader. The one-sided half is the `legacy_only` bar above; this one
    // keeps the two-sided fixture and asserts the Phase 4 meaning. Together they
    // still fail if anyone reintroduces a sale_status read (this one would go to
    // EXIT_TIER, `legacy_only` would leave 0), and this one also fails if the
    // tier-3 branch goes missing.
    check(
      `⭐ REGISTRATION ledger row + a legacy 'lead' row ⇒ ${TIER_REGISTERED} (Registered), NOT ${EXIT_TIER}`,
      (await tierFor(campA.campaignId, cid.registration_ledger)) === TIER_REGISTERED,
      `got ${await tierFor(campA.campaignId, cid.registration_ledger)}`,
    );

    // ⭐ PHASE 4 CONTROLS — one-sided, no legacy column written at all.
    console.log("\nCampaign A — Registered (tier 3) controls:");
    check(
      `⭐ registration only ⇒ tier ${TIER_REGISTERED} (Registered)`,
      (await tierFor(campA.campaignId, cid.registered_only)) === TIER_REGISTERED,
      `got ${await tierFor(campA.campaignId, cid.registered_only)}`,
    );
    check(
      `⭐ registration + REJECTED purchase ⇒ NOT ${TIER_REGISTERED}, falls back to the click tier ${TIER_CLICKED}`,
      (await tierFor(campA.campaignId, cid.registered_rejected)) === TIER_CLICKED,
      `got ${await tierFor(campA.campaignId, cid.registered_rejected)}`,
    );

    // ====================================================================
    // ASSERTIONS — campaign B (the OTHER campaign) — confirms scoping both ways
    // ====================================================================
    console.log("\nCampaign B (the other campaign):");
    check(
      `purchase-in-B contact → ${EXIT_TIER} in B (scoping reads the other side)`,
      (await tierFor(campB.campaignId, cid.click_here_sale_b)) === EXIT_TIER,
      `got ${await tierFor(campB.campaignId, cid.click_here_sale_b)}`,
    );
    check(
      `reached + purchase-in-B contact → ${EXIT_TIER} in B`,
      (await tierFor(campB.campaignId, cid.other_campaign)) === EXIT_TIER,
      `got ${await tierFor(campB.campaignId, cid.other_campaign)}`,
    );
    check(
      "A-only clicker → 0 in B (scoping)",
      (await tierFor(campB.campaignId, cid.clicked)) === 0,
    );
  } finally {
    console.log("\nCleanup");
    try {
      // conversion_events.campaign_id is ON DELETE SET NULL, not CASCADE, so the
      // fixture rows must be deleted BEFORE the campaigns — otherwise the
      // campaign_id scoping below can no longer find them.
      if (createdCampaignIds.length > 0) {
        const campaignArray = drizzleSql`ARRAY[${drizzleSql.join(
          createdCampaignIds.map((c) => drizzleSql`${c}`),
          drizzleSql`, `,
        )}]::int[]`;
        await db.execute(drizzleSql`
          DELETE FROM conversion_events
          WHERE org_id = ${orgId}::uuid
            AND keitaro_event_id LIKE 'fixture-%'
            AND campaign_id = ANY(${campaignArray})
        `);
      }
      // Deleting campaigns cascades campaign_stages, stage_sends, links (and
      // clicks via links) — clearing the RESTRICT refs to short_domain/dest.
      for (const c of createdCampaignIds) {
        await db.execute(drizzleSql`DELETE FROM campaigns WHERE id = ${c}`);
      }
      if (destId) {
        await db.execute(drizzleSql`DELETE FROM link_destinations WHERE id = ${destId}`);
      }
      if (shortDomainId) {
        await db.execute(drizzleSql`DELETE FROM short_domains WHERE id = ${shortDomainId}`);
      }
      if (insertedPhones.length > 0) {
        const phoneArray = drizzleSql`ARRAY[${drizzleSql.join(
          insertedPhones.map((p) => drizzleSql`${p}`),
          drizzleSql`, `,
        )}]::text[]`;
        await db.execute(drizzleSql`
          DELETE FROM contacts
          WHERE org_id = ${orgId}::uuid
            AND phone_number = ANY(${phoneArray})
        `);
      }
      if (brandId) {
        await db.execute(drizzleSql`DELETE FROM brands WHERE id = ${brandId}`);
      }
      console.log("  cleanup complete");
    } finally {
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
