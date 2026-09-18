import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { campaignTierExpr } from "@/lib/campaign-tier";
import { stageRecipientsSql, type StageRecipientFilters } from "@/lib/sends/recipients";

import { seedConversionEvent } from "./_conversion-fixture";

// The Registered lane (Phase 4), through the REAL campaignTierExpr and the REAL
// stageRecipientsSql, on fixtures this script seeds.
//
// PREVIEW DB ONLY, in a transaction that ALWAYS rolls back:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-registered-lane-db.ts
//
// ⭐ EVERY FIXTURE IS ONE-SIDED. A contact carrying both a registration and a
// purchase reads the same under the old numbering and the new one, so it proves
// nothing. Six roles, six shapes, and the mutation each one catches:
//
//   reg         registration only, offer reached   → tier 3 · catches "the tier-3
//               branch is missing" (old code puts it in the tier-2 lane)
//   regbare     registration only, NO click, NO reach → tier 3 · catches "a
//               registration alone does not lift a contact out of Ignored"
//   rejreg      registration + REJECTED purchase   → tier 2 · catches "the NOT
//               EXISTS purchase guard is missing" (that bug makes lane3 = {reg,rejreg})
//   regunmapped registration + a purchase-type row with status NULL (UNMAPPED)
//               → tier 3 · catches "the NOT EXISTS has no status predicate",
//               which would let a row this codebase counts as NOTHING evict a
//               registrant from the lane
//   cnvreg      registration + APPROVED purchase   → tier 4, NO lane · catches
//               "the scale was APPENDED instead of renumbered" (MAX would rank
//               Registered above Purchased and message a buyer again)
//   rch         offer reached only                 → tier 2 · the control that
//               must NOT move
//
// ⚠️ LANE MEMBERSHIP FREEZES AT MATERIALIZATION. A contact who registers after
// their lane materialized is still sent that lane's message; the drain re-checks
// only opt-outs and the 1-hour phone dedup. The send-time re-check is a SEPARATE
// card and is out of scope here.
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function main() {
  const isPreview = (process.env.DATABASE_URL ?? "").includes("fdzxzxayhknywvmrhjcj");
  console.log(`Target DB: ${isPreview ? "camman-v2 (preview)" : "UNKNOWN"}\n`);
  if (!isPreview) {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  let rolledBack = false;
  try {
    await db.transaction(async (tx: Tx) => {
      const sfx = String(Date.now()).slice(-7);

      // A throwaway org, so event_types is seeded by THIS script and the ledger
      // starts empty (the preview DB has 0 conversion_events).
      const orgId = (
        (await tx.execute(sql`
          INSERT INTO organizations (name) VALUES (${"__P4_REG_LANE__ " + sfx})
          RETURNING id::text AS id`)) as unknown as { id: string }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
        VALUES (${orgId}::uuid, 'purchase', 'Purchase', 10, true, true, false),
               (${orgId}::uuid, 'registration', 'Registration', 20, false, false, true)`);

      const brandId = (
        (await tx.execute(sql`
          INSERT INTO brands (org_id, brand_id, name)
          VALUES (${orgId}::uuid, ${"P4-" + sfx}, ${"P4 Brand " + sfx}) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain)
        VALUES (${orgId}::uuid, ${brandId}::int, ${"p4-" + sfx + ".test"})`);
      await tx.execute(sql`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${orgId}::uuid, 'https://example.test/o', ${"h-" + sfx})`);
      const campaignId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, brand_id, status, link_mode)
          VALUES (${orgId}::uuid, ${"p4-" + sfx}, 'P4 reg lane', ${brandId}::int, 'active', 'tracked')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const parentStageId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
          VALUES (${orgId}::uuid, ${campaignId}::int, 1) RETURNING id`)) as unknown as { id: number }[]
      )[0].id;

      const roles = ["reg", "regbare", "rejreg", "regunmapped", "cnvreg", "rch"] as const;
      const cid: Record<string, string> = {};
      for (const [i, role] of roles.entries()) {
        cid[role] = (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
            VALUES (${orgId}::uuid, ${"+1888" + sfx + i}, now(), now())
            RETURNING id::text AS id`)) as unknown as { id: string }[]
        )[0].id;
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool
            (campaign_id, contact_id, org_id, was_clicker_at_snapshot,
             was_opt_in_at_snapshot, was_no_status_at_snapshot)
          VALUES (${campaignId}::int, ${cid[role]}::uuid, ${orgId}::uuid, false, false, true)`);
      }

      // Every role received the parent stage (alive). `reached` stamps the
      // offer-reach signal; sale_status is deliberately left NULL on every row —
      // the ledger is the only source now.
      async function received(role: string, reached: boolean): Promise<string> {
        return (
          (await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
               offer_reached_at, offer_reach_event_id)
            VALUES (${orgId}::uuid, ${campaignId}::int, ${parentStageId}::int,
                    ${cid[role]}::uuid, ${"+1888" + sfx}, 'body', 'sent',
                    ${reached ? sql`now()` : sql`NULL`},
                    ${reached ? `evt-${role}-${sfx}` : null})
            RETURNING id::text AS id`)) as unknown as { id: string }[]
        )[0].id;
      }

      const sReg = await received("reg", true);
      const sBare = await received("regbare", false);
      const sRej = await received("rejreg", true);
      const sUnm = await received("regunmapped", true);
      const sCnv = await received("cnvreg", true);
      await received("rch", true);

      const reg = (stageSendId: string, role: string) =>
        seedConversionEvent(tx, {
          orgId, stageSendId, contactId: cid[role], campaignId, stageId: parentStageId,
          eventKey: "registration", status: "approved", revenue: 0, keitaroType: "lead",
        });
      const buy = (stageSendId: string, role: string, status: "approved" | "rejected") =>
        seedConversionEvent(tx, {
          orgId, stageSendId, contactId: cid[role], campaignId, stageId: parentStageId,
          eventKey: "purchase", status, revenue: 100, keitaroType: "sale",
        });

      await reg(sReg, "reg");
      await reg(sBare, "regbare");
      await reg(sRej, "rejreg");
      await buy(sRej, "rejreg", "rejected");
      await reg(sCnv, "cnvreg");
      await buy(sCnv, "cnvreg", "approved");

      // The UNMAPPED-STATUS purchase row. Raw SQL, not seedConversionEvent:
      // that helper ties status to eventKey (omit the key and event_type_id goes
      // NULL too), and the shape that matters here is a MAPPED purchase type
      // with an UNMAPPED status — the combination the NOT EXISTS must ignore.
      await reg(sUnm, "regunmapped");
      const purchaseTypeId = (
        (await tx.execute(sql`
          SELECT id FROM event_types WHERE org_id = ${orgId}::uuid AND key = 'purchase'
        `)) as unknown as { id: number }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status,
           revenue, occurred_at, last_postback_at, stage_send_id, contact_id, campaign_id, stage_id)
        VALUES (${orgId}::uuid, ${"fixture-unmapped-" + sfx}, 'weird_status', 'sale',
                ${purchaseTypeId}::int, NULL, 0::numeric, now(), now(),
                ${sUnm}::uuid, ${cid.regunmapped}::uuid, ${campaignId}::int, ${parentStageId}::int)`);

      // ── the fragment ──────────────────────────────────────────────────────
      async function tierFor(role: string): Promise<number> {
        const rows = (await tx.execute(sql`
          SELECT COALESCE((
            SELECT t.tier FROM (${campaignTierExpr(campaignId, orgId)}) t
            WHERE t.contact_id = ${cid[role]}::uuid
          ), 0)::int AS tier`)) as unknown as { tier: number }[];
        return Number(rows[0]?.tier ?? -1);
      }

      const tiers: Record<string, number> = {};
      for (const role of roles) tiers[role] = await tierFor(role);

      console.log("Tier fragment:");
      check("T1 ⭐ registration + offer reach ⇒ tier 3 (Registered, above reached-offer)", tiers.reg === 3, `got ${tiers.reg}`);
      check("T2 ⭐ registration with NO click and NO reach ⇒ tier 3 (a registration alone lifts the contact out of Ignored)", tiers.regbare === 3, `got ${tiers.regbare}`);
      check("T3 ⭐ registration + REJECTED purchase ⇒ tier 2, NOT 3 (a rejected purchase does not return a contact to Registered)", tiers.rejreg === 2, `got ${tiers.rejreg}`);
      check("T4 ⭐ registration + APPROVED purchase ⇒ tier 4, the EXIT (a buyer is never Registered)", tiers.cnvreg === 4, `got ${tiers.cnvreg}`);
      check("T5 offer reach only ⇒ tier 2 (the control that must not move)", tiers.rch === 2, `got ${tiers.rch}`);
      check("T6 ⭐ registration + an UNMAPPED-STATUS purchase row ⇒ tier 3 — an unmapped row counts as NOTHING and must not evict a registrant", tiers.regunmapped === 3, `got ${tiers.regunmapped}`);

      // ── the lanes ─────────────────────────────────────────────────────────
      const laneFilters = (tier: number): StageRecipientFilters => ({
        includeNoStatus: true, includeClickers: true, excludeClickers: false,
        splitIndex: null, splitTotal: null, behavioralTier: tier, parentStageId,
      });
      async function lane(tier: number): Promise<Set<string>> {
        const rows = (await tx.execute(
          stageRecipientsSql({ campaignId, orgId, filters: laneFilters(tier) }),
        )) as unknown as { contact_id: string }[];
        return new Set(rows.map((r) => r.contact_id));
      }
      const roleOf = (s: Set<string>) =>
        roles.filter((r) => s.has(cid[r])).slice().sort().join(",");

      const l0 = await lane(0);
      const l1 = await lane(1);
      const l2 = await lane(2);
      const l3 = await lane(3);

      console.log("\nLanes:");
      check("L1 tier-0 lane is empty (every fixture has a signal)", roleOf(l0) === "", roleOf(l0));
      check("L2 tier-1 lane is empty (no fixture clicked)", roleOf(l1) === "", roleOf(l1));
      check("L3 tier-2 lane = {rch, rejreg}", roleOf(l2) === "rch,rejreg", roleOf(l2));
      check("L4 ⭐ tier-3 lane = {reg, regbare, regunmapped} EXACTLY — not the rejected-purchase contact, not the buyer",
        roleOf(l3) === "reg,regbare,regunmapped", roleOf(l3));
      check("L5 ⭐ the buyer is in NO lane at all", ![l0, l1, l2, l3].some((s) => s.has(cid.cnvreg)));
      check("L6 the four lanes are pairwise disjoint",
        [l0, l1, l2, l3].flatMap((a, i) => [l0, l1, l2, l3].slice(i + 1).map((b) => [...a].every((x) => !b.has(x)))).every(Boolean));
      check("L7 every alive contact is in exactly one lane OR at the exit",
        l0.size + l1.size + l2.size + l3.size === roles.length - 1);

      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) rolledBack = true;
    else throw e;
  }
  check("L8 the probe transaction rolled back", rolledBack);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pgConn.end();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
