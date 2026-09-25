import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE OFFER RULES (869f53efz, PR 4d) against the PREVIEW DB:
// not more than N campaigns, and not within Y days.
//
// ⭐ Two bars carry the design and would both pass on a plausible wrong
// implementation without them:
//   M6b — ONE campaign carrying messages = 5 counts as 1, not 5. Counting
//         campaigns and counting messages agree on every fixture EXCEPT this
//         one, so without it both implementations look correct.
//   M7  — the CURRENT campaign is carved out of both counts. Without it,
//         stage 2 of a sequence is blocked by stage 1 and a drip
//         cannibalises itself on its second message.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-offer-limit-cooldown.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__OFFER_RULES_TEST__";

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
  const { buildStageEligibilityExclusions, EXCLUSION_PRIORITY } =
    await import("@/lib/sends/eligibility");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `offer-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const net = await one<{ id: number }>(
      sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`,
    );
    const offer = await one<{ id: number }>(
      sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`o-${tag}`}, ${net.id}, ${`O ${tag}`}) RETURNING id`,
    );
    const etSale = await one<{ id: number }>(sql`
      INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
      VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);

    const mkCampaign = async (label: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, offer_id)
          VALUES (${org}, ${`${label}-${tag}`}, ${label}, 'completed', 'manual', ${offer.id})
          RETURNING id`)
      ).id;
    // THE campaign under test, plus six others to spend the allowance in.
    const current = await mkCampaign("current");
    const others: number[] = [];
    for (let i = 0; i < 6; i++) others.push(await mkCampaign(`other${i}`));

    const phones = fictionalPhones(10);
    await refuseIfPhonesInUse(db, phones);
    const mk = async (i: number, lifecycle = "cold") =>
      (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${lifecycle}, 'mobile') RETURNING id`)
      ).id;

    // One contact_offer_campaigns row = the contact got this offer in that
    // campaign, `messages` times, last at `lastSent`.
    const exposure = async (
      contactId: string,
      campaignId: number,
      daysAgo: number,
      messages = 1,
    ) =>
      db.execute(sql`
        INSERT INTO contact_offer_campaigns
          (org_id, contact_id, offer_id, campaign_id, first_sent_at, last_sent_at, messages)
        VALUES (${org}, ${contactId}::uuid, ${offer.id}, ${campaignId},
                ${ago(daysAgo + 1)}::timestamptz, ${ago(daysAgo)}::timestamptz, ${messages})`);

    const cRecent = await mk(0); // 6 days ago, cooldown 7 ⇒ excluded
    const cOld = await mk(1); // 8 days ago ⇒ eligible
    const cJustIn = await mk(2); // 7d − 1h ⇒ EXCLUDED
    const cJustOut = await mk(9); // 7d + 1h ⇒ eligible
    const cFive = await mk(3); // 5 campaigns ⇒ at the limit
    const cFour = await mk(4); // 4 campaigns ⇒ under it
    const cBulk = await mk(5); // ONE campaign, messages = 5 ⇒ counts as 1
    const cOwn = await mk(6); // rows only under the CURRENT campaign
    const cBuyer = await mk(7); // inside the cooldown AND a buyer
    const cNone = await mk(8); // no rows at all

    await exposure(cRecent, others[0], 6);
    await exposure(cOld, others[0], 8);
    // ⚠️ The boundary is BRACKETED, not hit exactly. `now()` in SQL runs
    // seconds after the JS clock that built these timestamps, so a fixture one
    // second inside the line is decided by how long the script took — it
    // failed exactly that way on the first run. An hour either side pins the
    // DIRECTION of the comparison, which is the thing under test.
    await exposure(cJustIn, others[0], 7 - 1 / 24);
    await exposure(cJustOut, others[0], 7 + 1 / 24);
    for (let i = 0; i < 5; i++) await exposure(cFive, others[i], 30);
    for (let i = 0; i < 4; i++) await exposure(cFour, others[i], 30);
    await exposure(cBulk, others[0], 30, 5);
    // ONE row, because the PK is (contact, offer, campaign): a six-stage
    // campaign is a single row with messages = 6, not six rows. That is also
    // why counting campaigns and counting messages differ so sharply.
    await exposure(cOwn, current, 1, 6);
    await exposure(cBuyer, others[0], 2);
    await db.execute(sql`
      INSERT INTO conversion_events
        (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
         campaign_id, event_type_id, status, revenue, occurred_at)
      VALUES (${org}, ${`${tag}-buy`}, 'sale', 'sale', ${cBuyer}::uuid,
              ${others[0]}, ${etSale.id}, 'approved', '10.0000', now())`);

    const names: Record<string, string> = {
      [cRecent]: "recent-6d",
      [cOld]: "old-8d",
      [cJustIn]: "7d-minus-1h",
      [cJustOut]: "7d-plus-1h",
      [cFive]: "five-campaigns",
      [cFour]: "four-campaigns",
      [cBulk]: "one-campaign-5-msgs",
      [cOwn]: "own-campaign-only",
      [cBuyer]: "buyer-in-cooldown",
      [cNone]: "no-history",
    };

    // The real builder, then execute whichever layers it emits, per key.
    const layersFor = (opts: {
      offerRulesEnabled?: boolean;
      cooldown?: number;
      limit?: number;
      lifecycleRules?: boolean;
    }) =>
      buildStageEligibilityExclusions({
        orgId,
        currentCampaignId: current,
        currentCreativeId: null,
        currentOfferId: offer.id,
        excludePriorOffer: true,
        lifecycleRules: opts.lifecycleRules ?? true,
        offerRulesEnabled: opts.offerRulesEnabled ?? true,
        offerCooldownDays: opts.cooldown ?? 7,
        offerLimitTimes: opts.limit ?? 5,
      });
    const hits = async (key: string, opts = {}) => {
      const l = layersFor(opts).find((x) => x.key === key);
      if (!l) return new Set<string>();
      const rows = await all<{ contact_id: string }>(l.sql);
      return new Set(rows.map((r) => r.contact_id));
    };
    const named = (s: Set<string>) =>
      Object.keys(names)
        .filter((id) => s.has(id))
        .map((id) => names[id])
        .sort()
        .join(",") || "(none)";

    console.log("PART M — the offer cooldown and offer limit");

    const cd = await hits("offer_cooldown");
    bar(
      "M1 got it 6 days ago, cooldown 7 ⇒ EXCLUDED",
      cd.has(cRecent),
      named(cd),
    );
    bar("M2 got it 8 days ago ⇒ eligible", !cd.has(cOld), named(cd));
    bar(
      "M3 ⭐ the boundary: 7d−1h EXCLUDED, 7d+1h eligible",
      cd.has(cJustIn) && !cd.has(cJustOut),
      "the rule is 'MORE than Y days ago' to be eligible — same `>` as the freeze cadence",
    );

    const lim = await hits("offer_limit");
    bar(
      "M4 got it in 5 campaigns, limit 5 ⇒ EXCLUDED",
      lim.has(cFive),
      named(lim),
    );
    bar("M5 got it in 4 campaigns ⇒ eligible", !lim.has(cFour), named(lim));
    bar("M6 the count spans CAMPAIGNS, not one of them", lim.has(cFive));
    // ⭐ The bar that separates counting campaigns from counting messages.
    bar(
      "M6b ⭐ ONE campaign with messages = 5 counts as 1, NOT 5",
      !lim.has(cBulk),
      "sum(messages) would exclude it; count(*) does not",
    );
    // ⭐ The carve-out.
    bar(
      "M7 ⭐ the CURRENT campaign is excluded from BOTH counts",
      !lim.has(cOwn) && !cd.has(cOwn),
      "one row, messages = 6, under the current campaign — stage 2 must not be blocked by stage 1",
    );

    // Priority: a buyer inside the cooldown reports bought_offer, not cooldown.
    const layers = layersFor({});
    const keys = layers.map((l) => l.key);
    const ranks = keys.map((k) =>
      (EXCLUSION_PRIORITY as readonly string[]).indexOf(k),
    );
    bar(
      "M8 ⭐ bought_offer sorts BEFORE the offer rules",
      ranks.every((r, i) => i === 0 || ranks[i - 1] < r) &&
        keys.indexOf("bought_offer") < keys.indexOf("offer_cooldown"),
      keys.join(" → "),
    );

    // A click does not reset either count.
    await db.execute(sql`
      INSERT INTO contact_engagement
        (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
         msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at,
         freeze_cadence_days, thresholds)
      VALUES (${cFive}::uuid, ${org}, 'hot', now(), 9, 0, 1, 1, 1, 1,
              ${ago(30)}::timestamptz, ${ago(1)}::timestamptz, 14, '{}'::jsonb)`);
    const limAfterClick = await hits("offer_limit");
    bar(
      "M9 ⭐ a human click YESTERDAY does not reset the count",
      limAfterClick.has(cFive),
      "engagement and offer fatigue are different things",
    );

    bar(
      "M10 a contact with NO history is eligible on both",
      !lim.has(cNone) && !cd.has(cNone),
    );

    // Legacy: the rules are off ⇒ neither layer exists, and LAYER 3 returns.
    const legacy = layersFor({ offerRulesEnabled: false }).map((l) => l.key);
    bar(
      "M11 with offer_rules_enabled FALSE, neither layer is built",
      !legacy.includes("offer_limit") && !legacy.includes("offer_cooldown"),
      legacy.join(",") || "(none)",
    );
    bar(
      "M12 ⭐ …and the LEGACY 'ever got' layer comes back instead",
      legacy.includes("offer"),
      "the two are alternatives, never stacked — stacked, a contact past their cooldown stays excluded forever",
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
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
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
              + (SELECT count(*) FROM contact_offer_campaigns WHERE org_id = ${orgId}::uuid)
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
