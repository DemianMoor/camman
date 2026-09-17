import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { buildConversionEventRows } from "../lib/conversions/build-rows";
import { loadLookups } from "../lib/conversions/ingest";
import type { LedgerSourceRow } from "../lib/conversions/keitaro-row";

// Attribution lookups for the conversion_events ledger, run through the REAL
// exported loadLookups inside a transaction that always rolls back. L1 reads an
// existing preview recipient chain; every other fixture (a second org, its
// network/offers/campaign/stages, mapping rules) is created inside the tx.
// PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-lookups.ts
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
const RUN = `test-cl-${Date.now()}`;
// Keitaro offer ids no real offer uses (int4-safe).
const K_DUP = 1_900_000_000 + (Date.now() % 100_000_000);
const K_UNIQ = K_DUP + 1;
const T_ACTIVE = "l2_active";
const T_ARCHIVED = "l2_archived";
const T_OTHER_ORG = "l3_other_org";

const src = (over: Partial<LedgerSourceRow>): LedgerSourceRow => ({
  eventId: `${RUN}-ev`,
  tid: null,
  clickSubid: "clk",
  subId1: null,
  subId3: null,
  keitaroStatus: "lead",
  keitaroType: "lead",
  revenue: "0.0000",
  currency: "USD",
  occurredAtEt: "2026-09-17 10:00:00",
  lastPostbackAtEt: "2026-09-17 10:00:00",
  keitaroOfferId: null,
  version: 1,
  statusHistory: null,
  rawParams: null,
  ...over,
});

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];

      // Anchor for L1: the chain read by a plain SQL join, independent of loadLookups.
      const chain = await one<{
        send_id: string; stage_id: number; contact_id: string; campaign_id: number;
        org_id: string; offer_id: number; network_id: number;
      }>(sql`
        SELECT ss.id::text AS send_id, ss.stage_id, ss.contact_id::text AS contact_id, st.campaign_id,
               c.org_id::text AS org_id, c.offer_id, o.network_id
        FROM stage_sends ss
        JOIN campaign_stages st ON st.id = ss.stage_id
        JOIN campaigns c ON c.id = st.campaign_id
        JOIN offers o ON o.id = c.offer_id
        ORDER BY ss.created_at LIMIT 1
      `);
      if (!chain) {
        check("L0 preview has a stage_send → stage → campaign → offer chain to read", false, "none found");
        throw new Rollback();
      }
      const orgA = chain.org_id;
      const purchaseA = await one<{ id: number }>(sql`SELECT id FROM event_types WHERE org_id = ${orgA}::uuid AND key = 'purchase'`);
      check("L0 fixtures: preview chain and org A's seeded purchase type exist", purchaseA !== undefined, JSON.stringify(chain));

      // Org B and its registry rows.
      const orgB = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${RUN}-org-b`}) RETURNING id::text AS id`))!.id;
      const netB = (await one<{ id: number }>(sql`
        INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${orgB}::uuid, ${`${RUN}-net-b`}, 'test net B') RETURNING id
      `))!.id;
      const newOffer = async (org: string, network: number, code: string, keitaroOfferId: number) =>
        (await one<{ id: number }>(sql`
          INSERT INTO offers (org_id, network_id, offer_id, name, keitaro_offer_id)
          VALUES (${org}::uuid, ${network}, ${`${RUN}-${code}`}, ${`test offer ${code}`}, ${keitaroOfferId}) RETURNING id
        `))!.id;
      await newOffer(orgA, chain.network_id, "a-dup", K_DUP);
      await newOffer(orgB, netB, "b-dup", K_DUP);
      const offerBUniq = await newOffer(orgB, netB, "b-uniq", K_UNIQ);

      const newStage = async (org: string, slug: string, trackingIds: string[]) => {
        const campaign = (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug) VALUES (${org}::uuid, ${`${RUN}-${slug}`}) RETURNING id
        `))!.id;
        const ids: number[] = [];
        for (const t of trackingIds) {
          ids.push((await one<{ id: number }>(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, tracking_id) VALUES (${org}::uuid, ${campaign}, ${t}) RETURNING id
          `))!.id);
        }
        return ids;
      };
      const DUP_TID = `${RUN}_s1_dup`;
      const UNIQ_TID = `${RUN}_s2_uniq`;
      await newStage(orgA, "a", [DUP_TID]);
      const [, stageBUniq] = await newStage(orgB, "b", [DUP_TID, UNIQ_TID]);

      // Mapping rules on org A's network: one active, one archived, and one owned by org B.
      await tx.execute(sql`
        INSERT INTO conversion_event_mappings (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status, status, archived_at)
        VALUES (${orgA}::uuid, ${chain.network_id}, ${T_ACTIVE}, ${purchaseA!.id}, 'approved', 'active', NULL),
               (${orgA}::uuid, ${chain.network_id}, ${T_ARCHIVED}, ${purchaseA!.id}, 'approved', 'archived', now()),
               (${orgB}::uuid, ${chain.network_id}, ${T_OTHER_ORG}, NULL, 'approved', 'active', NULL)
      `);

      const sources = [
        src({ eventId: `${RUN}-send`, subId1: chain.send_id, keitaroType: T_OTHER_ORG }),
        src({ eventId: `${RUN}-k-dup`, keitaroOfferId: K_DUP }),
        src({ eventId: `${RUN}-k-uniq`, keitaroOfferId: K_UNIQ }),
        src({ eventId: `${RUN}-t-dup`, subId3: DUP_TID }),
        src({ eventId: `${RUN}-t-uniq`, subId3: UNIQ_TID }),
      ];
      const lookups = await loadLookups(tx, sources);
      const built = buildConversionEventRows(sources, lookups);
      const rowFor = (id: string) => built.rows.find((r) => r.keitaroEventId === id);
      const unresolvedIds = built.unresolved.map((u) => u.eventId);

      const send = lookups.stageSends.get(chain.send_id);
      const stage = lookups.stages.get(chain.stage_id);
      check(
        "L1 a stage_sends id resolves to its stage + contact, and stage → campaign → offer → network → org",
        send?.stageId === chain.stage_id && send.contactId === chain.contact_id &&
          stage?.orgId === orgA && stage.campaignId === chain.campaign_id &&
          stage.offerId === chain.offer_id && stage.affiliateNetworkId === chain.network_id,
        JSON.stringify({ chain, send, stage }),
      );

      const typesA = (lookups.rulesByOrg.get(orgA) ?? []).map((r) => r.keitaroType);
      check(
        "L2 an ARCHIVED mapping rule is not returned (the active one on the same network is)",
        typesA.includes(T_ACTIVE) && !typesA.includes(T_ARCHIVED),
        JSON.stringify(typesA),
      );

      const typesB = (lookups.rulesByOrg.get(orgB) ?? []).map((r) => r.keitaroType);
      const sendRow = rowFor(`${RUN}-send`);
      check(
        "L3 a rule owned by org B (even on org A's network) is not returned for org A and doesn't classify org A's conversion",
        !typesA.includes(T_OTHER_ORG) && typesB.includes(T_OTHER_ORG) &&
          sendRow?.orgId === orgA && sendRow.status === null && sendRow.eventTypeId === null,
        JSON.stringify({ typesA, typesB, sendRow }),
      );

      const kUniq = lookups.offersByKeitaroId.get(K_UNIQ);
      check(
        "L4 a Keitaro offer id on offers in TWO orgs is dropped as ambiguous (unresolved); a single-org one resolves",
        !lookups.offersByKeitaroId.has(K_DUP) && unresolvedIds.includes(`${RUN}-k-dup`) &&
          kUniq?.orgId === orgB && kUniq.offerId === offerBUniq && kUniq.affiliateNetworkId === netB &&
          rowFor(`${RUN}-k-uniq`)?.offerId === offerBUniq,
        JSON.stringify({ kDup: lookups.offersByKeitaroId.get(K_DUP), kUniq, unresolvedIds }),
      );

      check(
        "L5 a tracking id present in two orgs is dropped as ambiguous (unresolved); a single-org one resolves",
        !lookups.stageIdByTrackingId.has(DUP_TID) && unresolvedIds.includes(`${RUN}-t-dup`) &&
          lookups.stageIdByTrackingId.get(UNIQ_TID) === stageBUniq &&
          rowFor(`${RUN}-t-uniq`)?.stageId === stageBUniq && rowFor(`${RUN}-t-uniq`)?.orgId === orgB,
        JSON.stringify({ dup: lookups.stageIdByTrackingId.get(DUP_TID), uniq: lookups.stageIdByTrackingId.get(UNIQ_TID), stageBUniq, unresolvedIds }),
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const [left] = (await db.execute(sql`
    SELECT (SELECT count(*) FROM organizations WHERE name LIKE ${`${RUN}%`})::int AS orgs,
           (SELECT count(*) FROM affiliate_networks WHERE network_id LIKE ${`${RUN}%`})::int AS networks,
           (SELECT count(*) FROM offers WHERE offer_id LIKE ${`${RUN}%`} OR keitaro_offer_id IN (${K_DUP}, ${K_UNIQ}))::int AS offers,
           (SELECT count(*) FROM campaigns WHERE slug LIKE ${`${RUN}%`})::int AS campaigns,
           (SELECT count(*) FROM campaign_stages WHERE tracking_id LIKE ${`${RUN}%`})::int AS stages,
           (SELECT count(*) FROM conversion_event_mappings WHERE keitaro_type IN (${T_ACTIVE}, ${T_ARCHIVED}, ${T_OTHER_ORG}))::int AS rules
  `)) as unknown as Record<string, number>[];
  check("L9 rolled back — no residue", Object.values(left).every((n) => n === 0), JSON.stringify(left));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
