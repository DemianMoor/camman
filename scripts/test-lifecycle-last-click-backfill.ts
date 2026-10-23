import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// scripts/backfill-lifecycle-last-click.ts against a throwaway org on the
// PREVIEW DB — the real script, run as a child process, dry run then --apply.
//
// Fixture: three warm stamps with NULL last_click_at, one human click and one
// bot click for the contact, and one hot stamp.
//   w1  sent AFTER the human click        ⇒ filled with that click
//   w2  sent BEFORE any human click       ⇒ stays NULL (no click at send)
//   w3  already has a last_click_at       ⇒ never overwritten
//   h   hot stamp                          ⇒ never touched (warm only)
//   the bot click is later than everything ⇒ never chosen
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-last-click-backfill.ts

import { execFileSync } from "node:child_process";

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LC_LAST_CLICK_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const tag = `lclb-${Date.now()}`;
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`);
    const dom = await one<{ id: number }>(sql`
      INSERT INTO short_domains (org_id, brand_id, domain) VALUES (${org}, ${brand.id}, ${`${tag}.example`}) RETURNING id`);
    const dest = await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash) VALUES (${org}, 'https://example.com/x', ${`h-${tag}`}) RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id)
      VALUES (${org}, ${`c-${tag}`}, ${`C ${tag}`}, 'completed', 'manual', ${brand.id}) RETURNING id`);
    const stage = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text, total_cost, sms_count, opt_out_count)
      VALUES (${org}, ${camp.id}, 1, 'STOP', '0', 0, 0) RETURNING id`)).id;
    const [phone] = fictionalPhones(1);
    await refuseIfPhonesInUse(db, [phone]);
    const contact = (await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number, line_type) VALUES (${org}, ${phone}, 'mobile') RETURNING id`)).id;

    const HUMAN_AT = "2026-08-10T12:00:00.000Z";
    const PRESET = "2026-07-01T00:00:00.000Z";
    const mkSend = async (sentAt: string, status: string, lastClickAt: string | null) => {
      const id = (await one<{ id: string }>(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (${org}, ${camp.id}, ${stage}, ${contact}::uuid, ${phone}, 'hi', 'sent', ${sentAt}::timestamptz)
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, last_click_at)
        VALUES (${id}::uuid, ${org}, ${status}, ${lastClickAt}::timestamptz)`);
      return id;
    };
    const w1 = await mkSend("2026-09-25T15:00:00Z", "warm", null);
    const w2 = await mkSend("2026-08-01T15:00:00Z", "warm", null);
    const w3 = await mkSend("2026-09-26T15:00:00Z", "warm", PRESET);
    const h = await mkSend("2026-09-27T15:00:00Z", "hot", null);

    const link = (await one<{ id: number }>(sql`
      INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                         contact_id, send_token, campaign_tracking_id, stage_tracking_id)
      VALUES (${org}, ${`${tag}-l`}, ${dom.id}, ${dest.id}, ${camp.id}, ${stage}, ${contact}::uuid,
              ${`t-${tag}`}, ${`ct-${tag}`}, ${`st-${tag}`}) RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at) VALUES
        (${org}, ${link}, ${HUMAN_AT}::timestamptz, 'human', now()),
        (${org}, ${link}, '2026-09-20T12:00:00Z'::timestamptz, 'bot', now())`);

    const read = async () =>
      Object.fromEntries(
        ((await db.execute(sql`
          SELECT stage_send_id::text AS id, last_click_at::text AS lca
          FROM stage_send_lifecycle WHERE org_id = ${org}`)) as unknown as { id: string; lca: string | null }[])
          .map((r) => [r.id, r.lca]),
      );
    const run = (apply: boolean) =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--conditions=react-server", "scripts/backfill-lifecycle-last-click.ts",
          "--org", orgId, ...(apply ? ["--apply"] : [])],
        { encoding: "utf8", env: process.env },
      );

    const dry = run(false);
    const afterDry = await read();
    bar("R1 dry run writes nothing", afterDry[w1] === null && afterDry[w2] === null, "w1/w2 still NULL");
    bar("R2 …and reports the two NULL warm stamps it would fill", /warm_stamps: 2\b/.test(dry), dry.match(/warm_stamps: \d+/)?.[0] ?? "");

    run(true);
    const after = await read();
    bar("A1 ⭐ a warm stamp sent after a human click gets THAT click (not the later bot one)",
      after[w1] !== null && Date.parse(after[w1]!) === Date.parse(HUMAN_AT), `${after[w1]}`);
    bar("A2 a warm stamp sent before any human click stays NULL", after[w2] === null, `${after[w2]}`);
    bar("A3 ⭐ an existing last_click_at is never overwritten",
      after[w3] !== null && Date.parse(after[w3]!) === Date.parse(PRESET), `${after[w3]}`);
    bar("A4 a non-warm stamp is never touched", after[h] === null, `${after[h]}`);
    const again = run(true);
    bar("A5 a second --apply writes nothing", /done: 0 stamp/.test(again), again.match(/done: [\d,]+ stamp/)?.[0] ?? "");
  } finally {
    if (orgId) {
      const name = (await one<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_send_lifecycle WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM clicks WHERE org_id = ${orgId}::uuid)) AS n`);
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
