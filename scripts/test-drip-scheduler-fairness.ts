import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { selectDueJourneys } from "@/lib/drip/scheduler";

// Drip scheduler per-campaign fairness (migration 0207), against the PREVIEW DB.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-scheduler-fairness.ts
//
// The 2026-10-12 shape: campaign A has a 250-journey backlog routed earlier,
// campaign B has 5 fresh journeys, campaign C is paused. Batch = 200.
//   F1  ⭐ flag OFF reproduces the starvation: B gets nothing (the test can fail)
//   F2  ⭐ flag ON: all 5 of B are in the batch, A fills the rest
//   F3  the batch interleaves campaigns: the first two rows are A#1 and B#1
//   F4  within a campaign the order is still oldest first, both ways
//   F5  a paused campaign is never selected, both ways
//   F6  no backlog (batch larger than the queue) ⇒ the same set both ways
// Read-only against the selector; fixture rows are deleted at the end.

const MARKER = "__DRIP_SCHED_FAIR_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    const keyId = (await createPartnerWithKey(db, { orgId, slug: "sf-" + sfx, name: "sf", token: "toksf" + sfx })).keyId;
    const campaign = async (tag: string, status: string) =>
      (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
        VALUES (${org}, ${`sf-${sfx}-${tag}`}, ${`SF ${tag}`}, ${status}, 'drip', 'tracked') RETURNING id`)).id;
    const A = await campaign("a", "active");
    const B = await campaign("b", "active");
    const C = await campaign("c", "paused");

    // n journeys for one campaign, routed starting `minutesAgo` ago, 1 s apart.
    let phoneSeq = 0;
    const journeys = async (campaignId: number, n: number, minutesAgo: number) => {
      const base = phoneSeq;
      phoneSeq += n;
      await db.execute(sql`
        WITH c AS (
          INSERT INTO contacts (org_id, phone_number)
          SELECT ${org}, '+1998' || ${sfx} || lpad((${base} + g)::text, 4, '0')
          FROM generate_series(1, ${n}) g
          RETURNING id, phone_number
        ), e AS (
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
          SELECT ${org}, c.id, ${keyId}, ${"sf-" + sfx}, now() - make_interval(mins => ${minutesAgo})
          FROM c
          RETURNING id, contact_id
        )
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at)
        SELECT ${org}, ${campaignId}, e.contact_id, e.id, 'routed',
               now() - make_interval(mins => ${minutesAgo})
                     + make_interval(secs => row_number() OVER (ORDER BY e.id))
        FROM e`);
    };
    await journeys(A, 250, 30); // the backlog, routed 30 min ago
    await journeys(B, 5, 1); // fresh
    await journeys(C, 3, 60); // paused campaign, oldest of all

    const off = await selectDueJourneys(db, { orgId, fair: false, batch: 200 });
    const on = await selectDueJourneys(db, { orgId, fair: true, batch: 200 });
    const count = (rows: { campaign_id: number }[], id: number) =>
      rows.filter((r) => Number(r.campaign_id) === id).length;

    bar("F1 ⭐ flag off reproduces the starvation: B gets 0 of 200",
      off.length === 200 && count(off, B) === 0 && count(off, A) === 200,
      `A ${count(off, A)}, B ${count(off, B)}`);
    bar("F2 ⭐ flag on: all 5 of B are in the batch, A fills the rest",
      on.length === 200 && count(on, B) === 5 && count(on, A) === 195,
      `A ${count(on, A)}, B ${count(on, B)}`);
    bar("F3 the batch interleaves: first two rows are one of each campaign",
      new Set(on.slice(0, 2).map((r) => Number(r.campaign_id))).size === 2,
      JSON.stringify(on.slice(0, 2).map((r) => r.campaign_id)));

    const routedOrder = async (ids: string[]) => {
      if (ids.length === 0) return true;
      const rows = (await db.execute(sql`
        SELECT id, routed_at FROM drip_journeys
        WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)) as unknown as
        { id: string; routed_at: string }[];
      const at = new Map(rows.map((r) => [r.id, new Date(r.routed_at).getTime()]));
      return ids.every((id, i) => i === 0 || at.get(ids[i - 1])! <= at.get(id)!);
    };
    const aIds = (rows: { campaign_id: number; journey_id: string }[]) =>
      rows.filter((r) => Number(r.campaign_id) === A).map((r) => r.journey_id);
    bar("F4 within campaign A the order is oldest first, both ways",
      (await routedOrder(aIds(off))) && (await routedOrder(aIds(on))));
    bar("F5 the paused campaign is never selected, both ways", count(off, C) === 0 && count(on, C) === 0);

    const allOff = await selectDueJourneys(db, { orgId, fair: false, batch: 1000 });
    const allOn = await selectDueJourneys(db, { orgId, fair: true, batch: 1000 });
    const ids = (rows: { journey_id: string }[]) => rows.map((r) => r.journey_id).sort().join(",");
    bar("F6 no backlog (batch > queue): the same 255 journeys both ways",
      allOff.length === 255 && ids(allOff) === ids(allOn), `off ${allOff.length}, on ${allOn.length}`);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
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
