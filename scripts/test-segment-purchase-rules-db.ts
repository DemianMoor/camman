import "./_env-preload";

import { sql, type SQL } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { restedCount } from "@/lib/audience/pool-math";
import { computeAudiencePools } from "@/lib/audience/pools";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";

import { seedConversionEvent } from "./_conversion-fixture";

// The three made_purchase* segment rules and the operator audience pools, run
// through the REAL exported app code against seeded rows. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-segment-purchase-rules-db.ts
//
// WHY THIS SCRIPT EXISTS. Phase 3 Task 2 moved these readers off
// stage_sends.sale_status onto the conversion_events ledger, and NOTHING
// executed the switched rules: test-purchase-rules.ts / test-offer-reach-rules.ts
// drive the HTTP API (no camman-v2 anon key locally) and
// test-segment-intersect-and-optout.ts looks up hand-curated prod segments by
// name. This runs the same code path with no HTTP and no named prod fixtures.
//
// ⭐ EVERY BAR IS DISCRIMINATING. Each fixture writes the ledger row and the
// legacy column SEPARATELY, never together, so a bar can only pass against the
// switched reader:
//   • ledger-only  (conversion_events purchase, sale_status NULL)   ⇒ IS a buyer
//   • legacy-only  (sale_status 'lead' + converted_at, no ledger)   ⇒ NOT a buyer
//   • rejected     (ledger purchase, status 'rejected')             ⇒ NOT a buyer
//   • registration (ledger registration + a legacy 'lead' row)      ⇒ NOT a buyer
// Seeding both sides on one contact — which every other script in this task
// does — makes the suite pass identically before and after the switch.
//
// ⚠️ FIXTURE SPLIT, AND WHY IT ISN'T ONE ROLLED-BACK TRANSACTION.
// buildSegmentAudienceClause reads the segment row and its rules through the
// MODULE-LEVEL `db` pool, which lands on a DIFFERENT connection from any
// transaction this script opens — an open transaction's uncommitted
// segments/segment_rules rows are invisible to it, the builder would see "zero
// active rules" and return the bare manual-membership clause, and every
// assertion below would silently degrade to testing manual membership. So the
// REGISTRY metadata the builder must read (a network, 2 brands, 2 offers, 4
// segments + their rules) is committed, then hard-deleted in `finally` and
// residue-checked. Everything that carries meaning — contacts, campaigns,
// stages, sends, contact groups, counted clickers and every conversion_events
// row — lives inside the transaction that ALWAYS rolls back.

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

const uuidArray = (ids: string[]): SQL =>
  sql`ARRAY[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::uuid[]`;

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "";
  const host = ref === PREVIEW_REF ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  const tag = `pr3-${Date.now()}`;
  // Committed registry metadata — see the FIXTURE SPLIT note above.
  let networkId: number | null = null;
  let networkIsOurs = false;
  const brandIds: number[] = [];
  const offerIds: number[] = [];
  const segmentIds: number[] = [];

  const orgs = (await db.execute(sql`
    SELECT id::text AS id FROM organizations ORDER BY created_at
  `)) as unknown as { id: string }[];
  const orgId = orgs[0]?.id;
  const otherOrgId = orgs[1]?.id ?? null;
  if (!orgId) {
    console.log("FAIL: no organization on the preview DB.");
    process.exit(1);
  }

  try {
    // ── committed registry metadata ────────────────────────────────────────
    const existingNet = (await db.execute(sql`
      SELECT id FROM affiliate_networks WHERE org_id = ${orgId}::uuid ORDER BY id LIMIT 1
    `)) as unknown as { id: number }[];
    if (existingNet[0]) {
      networkId = Number(existingNet[0].id);
    } else {
      networkId = Number(
        (
          (await db.execute(sql`
            INSERT INTO affiliate_networks (org_id, network_id, name)
            VALUES (${orgId}::uuid, ${`${tag}-net`}, ${`${tag} network`})
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );
      networkIsOurs = true;
    }

    for (const suffix of ["a", "b"]) {
      brandIds.push(
        Number(
          (
            (await db.execute(sql`
              INSERT INTO brands (org_id, brand_id, name)
              VALUES (${orgId}::uuid, ${`${tag}-brand-${suffix}`}, ${`${tag} brand ${suffix}`})
              RETURNING id
            `)) as unknown as { id: number }[]
          )[0].id,
        ),
      );
      offerIds.push(
        Number(
          (
            (await db.execute(sql`
              INSERT INTO offers (org_id, offer_id, name, network_id, payout_model, payout_cpa)
              VALUES (${orgId}::uuid, ${`${tag}-offer-${suffix}`}, ${`${tag} offer ${suffix}`},
                      ${networkId}::int, 'cpa', 1)
              RETURNING id
            `)) as unknown as { id: number }[]
          )[0].id,
        ),
      );
    }
    const [brandA, brandB] = brandIds;
    const [offerA, offerB] = offerIds;

    // One segment per rule under test. Separate segments (not a rule swapped in
    // place) so all four clauses can be built BEFORE the data transaction opens.
    async function seedSegmentWithRule(
      label: string,
      ruleType: string,
      value: number | null,
      operator: "is" | "is_not",
    ): Promise<number> {
      const segId = Number(
        (
          (await db.execute(sql`
            INSERT INTO segments (org_id, segment_id, name, status)
            VALUES (${orgId}::uuid, ${`${tag}-${label}`}, ${`${tag} ${label}`}, 'active')
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );
      segmentIds.push(segId);
      await db.execute(sql`
        INSERT INTO segment_rules
          (org_id, segment_id, rule_type, operator, value, position, is_active, combinator)
        VALUES (${orgId}::uuid, ${segId}::int, ${ruleType}, ${operator},
                ${value === null ? null : JSON.stringify(value)}::jsonb, 0, true, 'and')
      `);
      return segId;
    }

    const segAny = await seedSegmentWithRule("any", "made_purchase", null, "is");
    const segBrand = await seedSegmentWithRule("brand", "made_purchase_for_brand", brandA, "is");
    const segOffer = await seedSegmentWithRule("offer", "made_purchase_for_offer", offerA, "is");
    const segAnyNot = await seedSegmentWithRule("anynot", "made_purchase", null, "is_not");

    // The REAL builder. Its metadata reads happen here, against committed rows.
    const clauseAny = await buildSegmentAudienceClause(segAny, orgId);
    const clauseBrand = await buildSegmentAudienceClause(segBrand, orgId);
    const clauseOffer = await buildSegmentAudienceClause(segOffer, orgId);
    const clauseAnyNot = await buildSegmentAudienceClause(segAnyNot, orgId);
    const builtRules = (await db.execute(sql`
      SELECT count(*)::int AS n FROM segment_rules
      WHERE org_id = ${orgId}::uuid AND segment_id = ANY(${sql`ARRAY[${sql.join(
        segmentIds.map((i) => sql`${i}`),
        sql`, `,
      )}]::int[]`}) AND is_active
    `)) as unknown as { n: number }[];
    check("S0 four active purchase rules are committed for the builder to read", Number(builtRules[0].n) === 4);

    // ── the rolled-back data transaction ───────────────────────────────────
    let sawTx = false;
    try {
      await db.transaction(async (tx: Tx) => {
        sawTx = true;

        const campaign = async (brandId: number, offerId: number, suffix: string) => {
          const id = Number(
            (
              (await tx.execute(sql`
                INSERT INTO campaigns (org_id, slug, name, brand_id, offer_id, status)
                VALUES (${orgId}::uuid, ${`${tag}-${suffix}`}, ${`${tag} camp ${suffix}`},
                        ${brandId}::int, ${offerId}::int, 'draft')
                RETURNING id
              `)) as unknown as { id: number }[]
            )[0].id,
          );
          const stageId = Number(
            (
              (await tx.execute(sql`
                INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
                VALUES (${orgId}::uuid, ${id}::int, 1)
                RETURNING id
              `)) as unknown as { id: number }[]
            )[0].id,
          );
          return { id, stageId };
        };
        const campA = await campaign(brandA, offerA, "camp-a");
        const campB = await campaign(brandB, offerB, "camp-b");

        // Nine contacts, one per scenario.
        const roles = [
          "manual", //               manual member, no send, no conversion
          "ledger_pending", //  ⭐   ledger purchase (pending), sale_status NULL
          "ledger_clicked", //  ⭐   ledger purchase (approved) + a counted click
          "legacy_only", //     ⭐   sale_status 'lead' + converted_at, NO ledger row
          "legacy_clicked", //  ⭐   same, plus a counted click
          "rejected_ledger", // ⭐   ledger purchase, status 'rejected'
          "registration", //    ⭐   ledger REGISTRATION + a legacy 'lead' row
          "other_brand", //          ledger purchase on campaign B (brand B / offer B)
          "cross_org", //            ledger purchase row owned by the OTHER org
        ] as const;
        const cid: Record<string, string> = {};
        const phoneOf: Record<string, string> = {};
        for (const [i, role] of roles.entries()) {
          const phone = `+1213${String(Date.now()).slice(-6)}${i}`;
          phoneOf[role] = phone;
          cid[role] = (
            (await tx.execute(sql`
              INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone})
              RETURNING id::text AS id
            `)) as unknown as { id: string }[]
          )[0].id;
        }
        const allIds = roles.map((r) => cid[r]);

        const eligible = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM contacts
          WHERE id = ANY(${uuidArray(allIds)}) AND messaging_status = 'eligible'
        `)) as unknown as { n: number }[];
        check(
          "S1 precondition: all nine fixture contacts are messaging_status='eligible'",
          Number(eligible[0].n) === 9,
          `${eligible[0].n}/9 eligible — the audience clause's eligible gate would drop the rest`,
        );

        // A send row per contact. `legacy` stamps ONLY the projection columns;
        // the ledger row (if any) is seeded separately, never as a pair.
        async function send(
          camp: { id: number; stageId: number },
          role: string,
          legacy: boolean,
        ): Promise<string> {
          return (
            (await tx.execute(sql`
              INSERT INTO stage_sends
                (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
                 sent_at, sale_status, sale_revenue, converted_at)
              VALUES (${orgId}::uuid, ${camp.id}::int, ${camp.stageId}::int, ${cid[role]}::uuid,
                      ${phoneOf[role]}, 'probe', 'sent', now(),
                      ${legacy ? "lead" : null},
                      ${legacy ? "100.0000" : null}::numeric,
                      ${legacy ? sql`now()` : sql`NULL`})
              RETURNING id::text AS id
            `)) as unknown as { id: string }[]
          )[0].id;
        }

        const sLedgerPending = await send(campA, "ledger_pending", false);
        const sLedgerClicked = await send(campA, "ledger_clicked", false);
        await send(campA, "legacy_only", true);
        await send(campA, "legacy_clicked", true);
        const sRejected = await send(campA, "rejected_ledger", false);
        const sRegistration = await send(campA, "registration", true);
        const sOtherBrand = await send(campB, "other_brand", false);
        const sCrossOrg = await send(campA, "cross_org", false);

        // Ledger rows. NOTE which contacts are deliberately absent here:
        // legacy_only and legacy_clicked have NO conversion_events row at all.
        await seedConversionEvent(tx, {
          orgId,
          stageSendId: sLedgerPending,
          contactId: cid.ledger_pending,
          campaignId: campA.id,
          stageId: campA.stageId,
          offerId: offerA,
          eventKey: "purchase",
          status: "pending",
          revenue: 40,
        });
        await seedConversionEvent(tx, {
          orgId,
          stageSendId: sLedgerClicked,
          contactId: cid.ledger_clicked,
          campaignId: campA.id,
          stageId: campA.stageId,
          offerId: offerA,
          eventKey: "purchase",
          status: "approved",
          revenue: 90,
        });
        await seedConversionEvent(tx, {
          orgId,
          stageSendId: sRejected,
          contactId: cid.rejected_ledger,
          campaignId: campA.id,
          stageId: campA.stageId,
          offerId: offerA,
          eventKey: "purchase",
          status: "rejected",
          revenue: 90,
          keitaroType: "rejected",
        });
        // The motivating case for the whole phase: a $0 registration that the
        // legacy column recorded as 'lead' (⇒ a buyer). The ledger keeps it a
        // registration, and a registration is not a purchase.
        await seedConversionEvent(tx, {
          orgId,
          stageSendId: sRegistration,
          contactId: cid.registration,
          campaignId: campA.id,
          stageId: campA.stageId,
          offerId: offerA,
          eventKey: "registration",
          status: "approved",
          revenue: 0,
        });
        await seedConversionEvent(tx, {
          orgId,
          stageSendId: sOtherBrand,
          contactId: cid.other_brand,
          campaignId: campB.id,
          stageId: campB.stageId,
          offerId: offerB,
          eventKey: "purchase",
          status: "approved",
          revenue: 70,
        });
        if (otherOrgId) {
          // Same contact, same campaign — only ce.org_id differs. Exactly what
          // the rule's org filter has to catch.
          await seedConversionEvent(tx, {
            orgId: otherOrgId,
            stageSendId: sCrossOrg,
            contactId: cid.cross_org,
            campaignId: campA.id,
            eventKey: "purchase",
            status: "approved",
            revenue: 60,
          });
        }

        await tx.execute(sql`
          INSERT INTO segment_contacts (org_id, segment_id, contact_id)
          SELECT ${orgId}::uuid, s, ${cid.manual}::uuid
          FROM unnest(${sql`ARRAY[${sql.join(
            segmentIds.map((i) => sql`${i}`),
            sql`, `,
          )}]::int[]`}) AS s
        `);

        // ── the switched rules, through the real clause ──────────────────────
        const members = async (clause: SQL): Promise<Set<string>> => {
          const rows = (await tx.execute(sql`
            SELECT s.contact_id::text AS id FROM (${clause}) s
            WHERE s.contact_id = ANY(${uuidArray(allIds)})
          `)) as unknown as { id: string }[];
          return new Set(rows.map((r) => r.id));
        };
        const has = (set: Set<string>, role: string) => set.has(cid[role]);

        console.log("\nA. made_purchase (is) — org-wide");
        const A = await members(clauseAny);
        check("A1 ⭐ a LEDGER-ONLY purchase (pending, sale_status NULL) IS a buyer", has(A, "ledger_pending"));
        check("A2 ⭐ a LEDGER-ONLY purchase (approved) IS a buyer", has(A, "ledger_clicked"));
        check("A3 ⭐ a LEGACY-ONLY row (sale_status 'lead' + converted_at, no ledger) is NOT a buyer", !has(A, "legacy_only"));
        check("A4 ⭐ a second legacy-only row is NOT a buyer", !has(A, "legacy_clicked"));
        check("A5 ⭐ a REJECTED ledger purchase is NOT a buyer", !has(A, "rejected_ledger"));
        check("A6 ⭐ a REGISTRATION (with a legacy 'lead' row next to it) is NOT a buyer", !has(A, "registration"));
        check("A7 a purchase under another brand/offer still counts org-wide", has(A, "other_brand"));
        check("A8 manual membership survives the rule UNION", has(A, "manual"));
        if (otherOrgId) {
          check("A9 org scoping: the OTHER org's purchase on this contact is not a buyer", !has(A, "cross_org"));
        } else {
          console.log("  SKIP  A9 — the preview DB has only one organization");
        }

        console.log("\nB. made_purchase_for_brand / _for_offer scoping");
        const B = await members(clauseBrand);
        check("B1 ⭐ the ledger-only buyer is selected for brand A", has(B, "ledger_pending"));
        check("B2 a purchase on brand B is NOT selected for brand A", !has(B, "other_brand"));
        check("B3 ⭐ the legacy-only row is not selected for brand A either", !has(B, "legacy_only"));
        check("B4 manual membership survives", has(B, "manual"));
        const C = await members(clauseOffer);
        check("B5 ⭐ the ledger-only buyer is selected for offer A", has(C, "ledger_pending"));
        check("B6 a purchase on offer B is NOT selected for offer A", !has(C, "other_brand"));
        check("B7 ⭐ the legacy-only row is not selected for offer A either", !has(C, "legacy_only"));

        console.log("\nC. made_purchase (is_not) — the complement");
        const D = await members(clauseAnyNot);
        check("C1 ⭐ the ledger-only buyer is EXCLUDED by is_not", !has(D, "ledger_pending"));
        check("C2 ⭐ the legacy-only row IS in the non-buyer audience", has(D, "legacy_only"));
        check("C3 ⭐ the rejected purchase IS in the non-buyer audience", has(D, "rejected_ledger"));
        check("C4 ⭐ the registration IS in the non-buyer audience", has(D, "registration"));
        check("C5 manual membership is in both directions", has(D, "manual"));
        // |is| + |is_not| = |eligible org contacts| + |eligible manual members|.
        // Derivation: manual ⊆ U and buyers ⊆ U, so
        // |m ∪ B| + |m ∪ (U∖B)| = (|m|+|B|−|m∩B|) + (|U|−|B|+|m∩B|) = |U| + |m|.
        const totals = (await tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM (${clauseAny}) x) AS is_n,
            (SELECT count(*)::int FROM (${clauseAnyNot}) y) AS not_n,
            (SELECT count(*)::int FROM contacts
               WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible') AS universe,
            (SELECT count(*)::int FROM segment_contacts sc
               JOIN contacts c ON c.id = sc.contact_id AND c.messaging_status = 'eligible'
               WHERE sc.segment_id = ${segAny}::int AND sc.org_id = ${orgId}::uuid) AS manual
        `)) as unknown as { is_n: number; not_n: number; universe: number; manual: number }[];
        const t = totals[0];
        check(
          "C6 inversion invariant: |is| + |is_not| = |eligible org contacts| + |eligible manual members|",
          Number(t.is_n) + Number(t.not_n) === Number(t.universe) + Number(t.manual),
          `${t.is_n}+${t.not_n}=${Number(t.is_n) + Number(t.not_n)}, expected ${Number(t.universe) + Number(t.manual)}`,
        );

        // ── the operator audience pools ─────────────────────────────────────
        // One contact per group, so the histograms are counts of exactly one
        // known contact and a wrong 'converted' answer cannot cancel out.
        console.log("\nD. operator audience pools (computeAudiencePools)");
        const groupOf: Record<string, number> = {};
        for (const role of ["ledger_pending", "legacy_only", "rejected_ledger", "ledger_clicked", "legacy_clicked"]) {
          const gid = Number(
            (
              (await tx.execute(sql`
                INSERT INTO contact_groups (org_id, contact_group_id, name, status)
                VALUES (${orgId}::uuid, ${`${tag}-g-${role}`}, ${`${tag} g ${role}`}, 'active')
                RETURNING id
              `)) as unknown as { id: number }[]
            )[0].id,
          );
          groupOf[role] = gid;
          await tx.execute(sql`
            INSERT INTO contact_contact_groups (org_id, contact_id, contact_group_id)
            VALUES (${orgId}::uuid, ${cid[role]}::uuid, ${gid}::int)
          `);
        }
        for (const role of ["ledger_clicked", "legacy_clicked"]) {
          await tx.execute(sql`
            INSERT INTO counted_clickers (org_id, campaign_id, stage_id, contact_id, first_click_at)
            VALUES (${orgId}::uuid, ${campA.id}::int, ${campA.stageId}::int, ${cid[role]}::uuid, now())
          `);
        }

        const { snapshot } = await computeAudiencePools(tx, orgId);
        const offerHist = snapshot.offers[String(offerA)];
        check("D0 offer A appears in the snapshot (it has sent messages)", offerHist != null);
        if (offerHist) {
          const g = (role: string) => String(groupOf[role]);
          const received = (role: string) => restedCount(offerHist.received[g(role)], 0);
          const notClicked = (role: string) => restedCount(offerHist.received_not_clicked[g(role)], 0);
          const nonBuyers = (role: string) => restedCount(offerHist.clickers_non_buyers[g(role)], 0);

          check(
            "D1 each single-contact group received exactly one message of offer A",
            [1, 1, 1, 1, 1].every(
              (want, i) =>
                received(
                  ["ledger_pending", "legacy_only", "rejected_ledger", "ledger_clicked", "legacy_clicked"][i],
                ) === want,
            ),
            `received: ${["ledger_pending", "legacy_only", "rejected_ledger", "ledger_clicked", "legacy_clicked"]
              .map((r) => `${r}=${received(r)}`)
              .join(" ")}`,
          );
          check(
            "D2 ⭐ the LEDGER-ONLY buyer is converted ⇒ 0 in received_not_clicked",
            notClicked("ledger_pending") === 0,
            `got ${notClicked("ledger_pending")}`,
          );
          check(
            "D3 ⭐ the LEGACY-ONLY row is NOT converted ⇒ 1 in received_not_clicked",
            notClicked("legacy_only") === 1,
            `got ${notClicked("legacy_only")}`,
          );
          check(
            "D4 ⭐ a REJECTED ledger purchase is NOT converted ⇒ 1 in received_not_clicked",
            notClicked("rejected_ledger") === 1,
            `got ${notClicked("rejected_ledger")}`,
          );
          check(
            "D5 ⭐ a clicker with a LEDGER purchase is a buyer ⇒ 0 in clickers_non_buyers",
            nonBuyers("ledger_clicked") === 0,
            `got ${nonBuyers("ledger_clicked")}`,
          );
          check(
            "D6 ⭐ a clicker with only a LEGACY row is not a buyer ⇒ 1 in clickers_non_buyers",
            nonBuyers("legacy_clicked") === 1,
            `got ${nonBuyers("legacy_clicked")}`,
          );
        }

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    check("E1 the data transaction ran and rolled back", sawTx);

    const residueTx = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM campaigns WHERE slug LIKE ${`${tag}-%`}) AS camps,
        (SELECT count(*)::int FROM contact_groups WHERE contact_group_id LIKE ${`${tag}-%`}) AS groups,
        (SELECT count(*)::int FROM segment_contacts sc
           WHERE sc.segment_id = ANY(${sql`ARRAY[${sql.join(
             segmentIds.map((i) => sql`${i}`),
             sql`, `,
           )}]::int[]`})) AS members
    `)) as unknown as { camps: number; groups: number; members: number }[];
    check(
      "E2 no campaign, contact group or membership survived the rollback",
      Number(residueTx[0].camps) === 0 &&
        Number(residueTx[0].groups) === 0 &&
        Number(residueTx[0].members) === 0,
      JSON.stringify(residueTx[0]),
    );
  } finally {
    // Hard-delete the committed registry metadata, FK order first.
    for (const id of segmentIds) {
      await db.execute(sql`DELETE FROM segments WHERE id = ${id}`);
    }
    for (const id of offerIds) {
      await db.execute(sql`DELETE FROM offers WHERE id = ${id}`);
    }
    for (const id of brandIds) {
      await db.execute(sql`DELETE FROM brands WHERE id = ${id}`);
    }
    if (networkId != null && networkIsOurs) {
      await db.execute(sql`DELETE FROM affiliate_networks WHERE id = ${networkId}`);
    }
  }

  const residue = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM segments WHERE segment_id LIKE ${`${tag}-%`}) AS segs,
      (SELECT count(*)::int FROM offers WHERE offer_id LIKE ${`${tag}-%`}) AS offers,
      (SELECT count(*)::int FROM brands WHERE brand_id LIKE ${`${tag}-%`}) AS brands,
      (SELECT count(*)::int FROM affiliate_networks WHERE network_id LIKE ${`${tag}-%`}) AS nets,
      (SELECT count(*)::int FROM conversion_events WHERE org_id = ${orgId}::uuid) AS ledger_rows
  `)) as unknown as {
    segs: number;
    offers: number;
    brands: number;
    nets: number;
    ledger_rows: number;
  }[];
  check(
    "E3 the committed registry metadata is gone (segments, offers, brands, network)",
    Number(residue[0].segs) === 0 &&
      Number(residue[0].offers) === 0 &&
      Number(residue[0].brands) === 0 &&
      Number(residue[0].nets) === 0,
    JSON.stringify(residue[0]),
  );
  console.log(`\n  (org ledger rows now: ${residue[0].ledger_rows})`);

  console.log(`\n${passed} passed, ${failed} failed  (data transaction rolled back)`);
  await pgConn.end({ timeout: 5 });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
