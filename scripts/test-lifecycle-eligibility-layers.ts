import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The three LIFECYCLE eligibility layers (PR 4b, spec §8.1) against the
// PREVIEW DB: suppressed, bought_offer, freeze_not_due.
//
// These decide who does NOT receive a message. Every bar goes through
// buildStageEligibilityExclusions — the real builder the send path, the export
// and the preview all share — and executes the SQL it returns. Nothing here
// re-spells a predicate; a test that rebuilt the layer would only be comparing
// the layer to a copy of itself.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-eligibility-layers.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__LIFECYCLE_ELIGIBILITY_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const {
    buildStageEligibilityExclusions,
    EXCLUSION_PRIORITY,
    eligibilityUnion,
  } = await import("@/lib/sends/eligibility");
  const { buildSegmentAudienceClause } =
    await import("@/lib/segment-rules-eval");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `elig-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    // ── The world ──────────────────────────────────────────────────────────
    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
    );
    const net = await one<{ id: number }>(
      sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`,
    );
    const offerA = await one<{ id: number }>(
      sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`oa-${tag}`}, ${net.id}, ${`Offer A ${tag}`}) RETURNING id`,
    );
    const offerB = await one<{ id: number }>(
      sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`ob-${tag}`}, ${net.id}, ${`Offer B ${tag}`}) RETURNING id`,
    );
    // is_purchase is what purchasedClause() keys off; the non-purchase type is
    // the control that must NOT count as a purchase.
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);
    const etReg = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'registration', 'Registration', false, false) RETURNING id`);

    // The campaign under test (offer A) and a DIFFERENT campaign the purchases
    // happened in — purchasedOfferContacts scopes the offer through the
    // campaign, so the purchase has to hang off a campaign to be visible.
    const campA = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id, lifecycle_rules)
      VALUES (${org}, ${`elig-a-${tag}`}, ${`Elig A ${tag}`}, 'draft', 'manual',
              ${brand.id}, ${offerA.id}, true) RETURNING id`);
    const campPast = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`elig-past-${tag}`}, ${`Elig past ${tag}`}, 'completed', 'manual',
              ${brand.id}, ${offerA.id}) RETURNING id`);
    const campOther = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`elig-other-${tag}`}, ${`Elig other ${tag}`}, 'completed', 'manual',
              ${brand.id}, ${offerB.id}) RETURNING id`);

    const phones = fictionalPhones(9);
    await refuseIfPhonesInUse(db, phones);

    const mk = async (
      i: number,
      lifecycle: string,
      engagement?: {
        status: string;
        last_sent_at: string | null;
        freeze_cadence_days: number;
      },
    ) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${lifecycle}, 'mobile') RETURNING id`)
      ).id;
      if (engagement) {
        const e = engagement;
        await db.execute(sql`
          INSERT INTO contact_engagement
            (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
             msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at,
             freeze_cadence_days, thresholds)
          VALUES (${id}::uuid, ${org}, ${e.status}, now(), 5, 5, 0, 0, 0, 0,
                  ${e.last_sent_at}::timestamptz, null, ${e.freeze_cadence_days}, '{}'::jsonb)`);
      }
      return id;
    };

    // name          idx  lifecycle    engagement
    const cCold = await mk(0, "cold", {
      status: "cold",
      last_sent_at: ago(200),
      freeze_cadence_days: 14,
    });
    const cHot = await mk(1, "hot", {
      status: "hot",
      last_sent_at: ago(2),
      freeze_cadence_days: 14,
    });
    const cSuppressed = await mk(2, "suppressed", {
      status: "suppressed",
      last_sent_at: ago(90),
      freeze_cadence_days: 14,
    });
    // ⭐ The cadence pair. SAME last_sent_at, DIFFERENT per-contact cadence:
    // the only thing that can separate them is freeze_cadence_days being read
    // per row. A hardcoded 30 (or a join to the group default) merges them.
    const cFreezeDue = await mk(3, "freeze", {
      status: "freeze",
      last_sent_at: ago(20),
      freeze_cadence_days: 14,
    });
    const cFreezeNotDue = await mk(4, "freeze", {
      status: "freeze",
      last_sent_at: ago(20),
      freeze_cadence_days: 45,
    });
    // Freeze, never messaged: last_sent_at NULL must not be "not due".
    const cFreezeNever = await mk(5, "freeze", {
      status: "freeze",
      last_sent_at: null,
      freeze_cadence_days: 14,
    });
    const cBoughtA = await mk(6, "warm", {
      status: "warm",
      last_sent_at: ago(10),
      freeze_cadence_days: 14,
    });
    const cBoughtB = await mk(7, "warm", {
      status: "warm",
      last_sent_at: ago(10),
      freeze_cadence_days: 14,
    });
    const cRegisteredA = await mk(8, "warm", {
      status: "warm",
      last_sent_at: ago(10),
      freeze_cadence_days: 14,
    });

    const names: Record<string, string> = {
      [cCold]: "cold",
      [cHot]: "hot",
      [cSuppressed]: "suppressed",
      [cFreezeDue]: "freeze-due",
      [cFreezeNotDue]: "freeze-notdue",
      [cFreezeNever]: "freeze-never",
      [cBoughtA]: "bought-A",
      [cBoughtB]: "bought-B",
      [cRegisteredA]: "registered-A",
    };
    const named = (s: Set<string>) =>
      Object.keys(names)
        .filter((id) => s.has(id))
        .map((id) => names[id])
        .sort()
        .join(",") || "(none)";

    const conv = async (
      contactId: string,
      campaignId: number,
      etId: number,
      status: string,
    ) =>
      db.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
           campaign_id, event_type_id, status, revenue, occurred_at)
        VALUES (${org}, ${`${tag}-${contactId}-${etId}-${campaignId}`}, 'sale', 'sale',
                ${contactId}::uuid, ${campaignId}, ${etId}, ${status}, '10.0000', now())`);

    await conv(cBoughtA, campPast.id, etSale.id, "approved"); // bought offer A
    await conv(cBoughtB, campOther.id, etSale.id, "approved"); // bought offer B, not A
    await conv(cRegisteredA, campPast.id, etReg.id, "approved"); // registered for A, not a purchase

    // ── The harness ────────────────────────────────────────────────────────
    // Run the real builder and execute the union of whatever layers it emits.
    const excludedBy = async (p: {
      offerId: number | null;
      lifecycleRules: boolean;
    }): Promise<Set<string>> => {
      const layers = buildStageEligibilityExclusions({
        orgId,
        currentCampaignId: campA.id,
        currentCreativeId: null, // isolate the lifecycle layers from content dedup
        currentOfferId: p.offerId,
        excludePriorOffer: false,
        lifecycleRules: p.lifecycleRules,
        offerRulesEnabled: false,
        offerCooldownDays: 7,
        offerLimitTimes: 5,
      });
      const union = eligibilityUnion(layers);
      if (!union) return new Set();
      const rows = await all<{ contact_id: string }>(union);
      return new Set(rows.map((r) => r.contact_id));
    };
    // The same, but one named layer at a time — so a bar can say WHICH layer.
    const layerRows = async (
      key: string,
      offerId: number | null,
    ): Promise<Set<string>> => {
      const layers = buildStageEligibilityExclusions({
        orgId,
        currentCampaignId: campA.id,
        currentCreativeId: null,
        currentOfferId: offerId,
        excludePriorOffer: false,
        lifecycleRules: true,
        offerRulesEnabled: false,
        offerCooldownDays: 7,
        offerLimitTimes: 5,
      });
      const l = layers.find((x) => x.key === key);
      if (!l) return new Set();
      const rows = await all<{ contact_id: string }>(l.sql);
      return new Set(rows.map((r) => r.contact_id));
    };

    console.log("PART E — the three lifecycle eligibility layers");

    // ── suppressed ─────────────────────────────────────────────────────────
    const eSup = await layerRows("suppressed", offerA.id);
    bar(
      "E1 the suppressed layer excludes exactly the suppressed contact",
      named(eSup) === "suppressed",
      named(eSup),
    );

    // ── freeze_not_due ─────────────────────────────────────────────────────
    const eFreeze = await layerRows("freeze_not_due", offerA.id);
    bar(
      "E2 freeze + messaged INSIDE the cadence is excluded",
      eFreeze.has(cFreezeNotDue),
      named(eFreeze),
    );
    bar(
      "E3 freeze + messaged OUTSIDE the cadence is NOT excluded",
      !eFreeze.has(cFreezeDue),
      named(eFreeze),
    );
    // ⭐ Both of the above from ONE pair differing only in freeze_cadence_days.
    bar(
      "E4 the cadence is read PER CONTACT, not from a constant",
      eFreeze.has(cFreezeNotDue) && !eFreeze.has(cFreezeDue),
      "same last_sent_at (20d), cadence 45 vs 14",
    );
    bar(
      "E5 freeze + NEVER messaged is not excluded (NULL last_sent_at)",
      !eFreeze.has(cFreezeNever),
      named(eFreeze),
    );
    bar(
      "E6 a non-freeze contact is never in the freeze layer",
      !eFreeze.has(cHot) && !eFreeze.has(cCold),
      named(eFreeze),
    );

    // ── bought_offer ───────────────────────────────────────────────────────
    const eBought = await layerRows("bought_offer", offerA.id);
    bar(
      "E7 bought THIS offer is excluded",
      eBought.has(cBoughtA),
      named(eBought),
    );
    bar(
      "E8 bought a DIFFERENT offer is not",
      !eBought.has(cBoughtB),
      named(eBought),
    );
    bar(
      "E9 a non-purchase event (registration) is not a purchase",
      !eBought.has(cRegisteredA),
      named(eBought),
    );

    // A NULL offer must not produce a layer at all — `offer_id = NULL` matches
    // nothing, so a built-anyway layer would be silently inert instead of absent.
    const noOfferLayers = buildStageEligibilityExclusions({
      orgId,
      currentCampaignId: campA.id,
      currentCreativeId: null,
      currentOfferId: null,
      excludePriorOffer: false,
      lifecycleRules: true,
      offerRulesEnabled: false,
      offerCooldownDays: 7,
      offerLimitTimes: 5,
    });
    bar(
      "E10 a campaign with NO offer emits no bought_offer layer",
      !noOfferLayers.some((l) => l.key === "bought_offer"),
      noOfferLayers.map((l) => l.key).join(",") || "(none)",
    );

    // ── the legacy campaign ────────────────────────────────────────────────
    const legacy = await excludedBy({
      offerId: offerA.id,
      lifecycleRules: false,
    });
    bar(
      "E11 with lifecycle_rules FALSE not one lifecycle layer is built",
      legacy.size === 0,
      named(legacy),
    );

    // ── the priority contract ──────────────────────────────────────────────
    // cSuppressed is ALSO inside a freeze-style cadence window; the layer list
    // must put suppressed first so the exclusion is reported under one reason.
    const layersAll = buildStageEligibilityExclusions({
      orgId,
      currentCampaignId: campA.id,
      currentCreativeId: null,
      currentOfferId: offerA.id,
      excludePriorOffer: false,
      lifecycleRules: true,
      offerRulesEnabled: false,
      offerCooldownDays: 7,
      offerLimitTimes: 5,
    });
    const keys = layersAll.map((l) => l.key);
    const ranks = keys.map((k) =>
      (EXCLUSION_PRIORITY as readonly string[]).indexOf(k),
    );
    bar(
      "E12 the layers come back in EXCLUSION_PRIORITY order",
      ranks.every((r, i) => i === 0 || ranks[i - 1] < r),
      keys.join(" → "),
    );

    // ── the anti-drift bar ─────────────────────────────────────────────────
    // The layer and the made_purchase_for_offer rule must be the SAME SQL. Both
    // read from purchasedOfferContacts today; comparing the ROWS would only
    // prove that one function equals itself. Comparing the emitted SQL TEXT
    // catches the thing that actually goes wrong: someone inlining a second
    // copy into either caller.
    const dialect = (
      db as unknown as {
        dialect: {
          sqlToQuery: (s: unknown) => { sql: string; params: unknown[] };
        };
      }
    ).dialect;
    // Placeholder NUMBERS shift with position ($1 standalone becomes $3 once
    // embedded), so mask them; the bound values are compared separately.
    const norm = (s: SQL) => {
      const q = dialect.sqlToQuery(s);
      return {
        text: q.sql.replace(/\$\d+/g, "$?").replace(/\s+/g, " ").trim(),
        params: q.params,
      };
    };

    // A REAL segment carrying the rule, evaluated by the real evaluator.
    const segId = (
      await one<{ id: number }>(sql`
        INSERT INTO segments (org_id, segment_id, name)
        VALUES (${org}, ${`${tag}-buy`}, ${`seg buy ${tag}`}) RETURNING id`)
    ).id;
    await db.execute(sql`
      INSERT INTO segment_rules
        (org_id, segment_id, rule_type, operator, value, position, is_active, combinator)
      VALUES (${org}, ${segId}, 'made_purchase_for_offer', 'is',
              ${JSON.stringify(offerA.id)}::jsonb, 0, true, 'and')`);
    const ruleClause = await buildSegmentAudienceClause(segId, orgId);

    const layerSql = layersAll.find((l) => l.key === "bought_offer")!.sql;
    const layer = norm(layerSql);
    const rule = norm(ruleClause);
    const textShared = rule.text.includes(layer.text);
    const paramsShared = layer.params.every((v) =>
      rule.params.some((w) => String(w) === String(v)),
    );
    bar(
      "E13 the bought_offer layer's SQL appears VERBATIM inside the rule's clause",
      textShared && paramsShared,
      textShared && paramsShared
        ? "one definition, two callers"
        : `text ${textShared ? "ok" : "DIFFERS"}, params ${paramsShared ? "ok" : "DIFFER"} — layer: ${layer.text.slice(0, 140)}`,
    );
  } finally {
    if (orgId) {
      const name =
        (
          await all<{ name: string }>(
            sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`,
          )
        )[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(
          `REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`,
        );
        fail++;
      } else {
        await db.execute(
          sql`DELETE FROM conversion_events WHERE org_id = ${orgId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`,
        );
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM conversion_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
