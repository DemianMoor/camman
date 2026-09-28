import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE PREVIEW AND THE FREEZE MUST AGREE — against the PREVIEW DB.
//
// ⭐ WHY THIS EXISTS AS ITS OWN FILE. `previewAudience` and `snapshotAudience`
// are two implementations of one question: who is in this campaign's audience.
// Every other suite tests one of them. Nothing tested that they give the SAME
// answer, and on 2026-09-28 they did not: PR 4d made the cooldown/limit pair
// REPLACE the permanent "ever got this offer" rule and changed
// snapshotAudience, while previewAudience kept applying the permanent rule AND
// merely reported the new ones.
//
// Measured on production for one real recipe — Hot/Warm × three Weight Loss
// groups × one offer, cooldown 30 / limit 5:
//
//   preview   77        ← what the operator sized the campaign from
//   snapshot  1,907     ← what activating it would have frozen
//
// The 1,830 contacts in between had received the offer once or twice and had
// since rested past their cooldown. They were on screen as excluded and would
// have been messaged anyway. A bar on either function alone passes happily
// while the two disagree; only comparing them catches it.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-preview-matches-snapshot.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__PREVIEW_MATCHES_SNAPSHOT_TEST__";

class Rollback extends Error {}

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { previewAudience, snapshotAudience } =
    await import("@/lib/audience-snapshot");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `pms-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const net = await one<{ id: number }>(sql`
      INSERT INTO affiliate_networks (org_id, network_id, name)
      VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`);
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const offer = await one<{ id: number }>(sql`
      INSERT INTO offers (org_id, offer_id, network_id, name)
      VALUES (${org}, ${`o-${tag}`}, ${net.id}, ${`O ${tag}`}) RETURNING id`);
    const group = await one<{ id: number }>(sql`
      INSERT INTO contact_groups (org_id, contact_group_id, name)
      VALUES (${org}, ${`g-${tag}`}, ${`G ${tag}`}) RETURNING id`);
    // The campaign under preview, plus an earlier one to carry the exposures.
    const mkCampaign = async (slug: string, status: string) =>
      (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
          VALUES (${org}, ${`${slug}-${tag}`}, ${`${slug} ${tag}`}, ${status},
                  'manual', ${brand.id}, ${offer.id}) RETURNING id`)
      ).id;
    const current = await mkCampaign("cur", "draft");
    const prior = await mkCampaign("pri", "completed");

    const phones = fictionalPhones(4);
    await refuseIfPhonesInUse(db, phones);
    const mk = async (i: number, status: string) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type, lifecycle_status)
          VALUES (${org}, ${phones[i]}, 'mobile', ${status}) RETURNING id`)
      ).id;
      await db.execute(sql`
        INSERT INTO contact_contact_groups (org_id, contact_id, contact_group_id)
        VALUES (${org}, ${id}::uuid, ${group.id})`);
      return id;
    };
    // ⚠️ THE TWO RULES READ DIFFERENT TABLES, and the fixture must feed both or
    // one of them silently has nothing to act on. The Y/N pair counts campaigns
    // in `contact_offer_campaigns`; the old permanent rule asks only "is there
    // an `offer_exposures` row". Populating just the first made the
    // permanent-rule case look like it excluded nobody.
    const exposure = async (cid: string, daysAgo: number, campaigns: number) => {
      await db.execute(sql`
        INSERT INTO offer_exposures
          (org_id, contact_id, offer_id, campaign_id, first_sent_at)
        VALUES (${org}, ${cid}::uuid, ${offer.id}, ${prior},
                now() - make_interval(days => ${daysAgo}::int))
        ON CONFLICT DO NOTHING`);
      for (let k = 0; k < campaigns; k++) {
        const c = k === 0 ? prior : await mkCampaign(`p${k}`, "completed");
        await db.execute(sql`
          INSERT INTO contact_offer_campaigns
            (org_id, contact_id, offer_id, campaign_id, messages,
             first_sent_at, last_sent_at)
          VALUES (${org}, ${cid}::uuid, ${offer.id}, ${c}, 1,
                  now() - make_interval(days => ${daysAgo}::int),
                  now() - make_interval(days => ${daysAgo}::int))`);
      }
    };

    // The three cases that separate the two rules. Under the PERMANENT rule
    // only cNever survives; under the Y/N rules cRested does too.
    const cNever = await mk(0, "hot");
    const cRested = await mk(1, "hot"); // got it once, 60 days ago
    const cRecent = await mk(2, "warm"); // got it once, 2 days ago
    const cOver = await mk(3, "hot"); // six campaigns, over the limit
    await exposure(cRested, 60, 1);
    await exposure(cRecent, 2, 1);
    await exposure(cOver, 60, 6);

    const base = {
      orgId,
      lifecycleRules: true,
      segmentIds: [] as number[],
      contactGroupIds: [group.id],
      filters: { lifecycle_statuses: ["hot", "warm"] },
      cap: null,
      excludeInUse: true,
      excludePriorOffer: true,
      offerRulesEnabled: true,
      offerCooldownDays: 30,
      offerLimitTimes: 5,
      offerId: offer.id,
    };
    const snapshotTotal = async (over: Record<string, unknown>) => {
      let total = 0;
      try {
        await db.transaction(async (tx) => {
          const r = await snapshotAudience(
            { ...base, ...over, campaignId: current } as never,
            tx,
          );
          total = r.total_matching;
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      return total;
    };

    const cases: [string, Record<string, unknown>, number][] = [
      // cNever + cRested. cRecent is inside the cooldown, cOver is at the limit.
      ["offer rules ON (cooldown 30, limit 5)", {}, 2],
      // Nothing is blocked once both rules are relaxed.
      ["cooldown 0, limit 999", { offerCooldownDays: 0, offerLimitTimes: 999 }, 4],
      // The OLD permanent rule: only the contact who never received it.
      ["offer rules OFF — permanent rule", { offerRulesEnabled: false }, 1],
      // Toggle off entirely: nobody is excluded for the offer at all.
      ["offer toggle off entirely", { excludePriorOffer: false }, 4],
    ];

    console.log("PART M — the preview equals the freeze");
    for (const [label, over, expected] of cases) {
      const p = (await previewAudience({ ...base, ...over } as never))
        .total_matching;
      const s = await snapshotTotal(over);
      bar(
        `M ${label}`,
        p === s && p === expected,
        `preview ${p}, snapshot ${s}, expected ${expected}`,
      );
    }

    // ⭐ The specific regression: with the Y/N rules on, a contact who is PAST
    // the cooldown must be IN the audience. Before the fix the preview applied
    // the permanent rule as well and dropped them, while activation kept them.
    const withRules = await previewAudience({ ...base } as never);
    bar(
      "M5 ⭐ a rested contact is in the PREVIEW, not just in the freeze",
      withRules.total_matching === 2,
      `${withRules.total_matching} — cNever + cRested`,
    );
    bar(
      "M6 …and the one still inside the cooldown is not",
      withRules.lifecycle?.excluded.offer_cooldown === 1,
      `cooldown bucket ${withRules.lifecycle?.excluded.offer_cooldown}`,
    );
    bar(
      "M7 …and the one over the limit is not",
      withRules.lifecycle?.excluded.offer_limit === 1,
      `limit bucket ${withRules.lifecycle?.excluded.offer_limit}`,
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
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_offer_campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
