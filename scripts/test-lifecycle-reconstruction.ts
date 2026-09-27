import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE 60-DAY RECONSTRUCTION (PR 5 Task 1) against the PREVIEW DB.
//
// ⭐ THE WHOLE FEATURE IS ONE ASSERTION: a contact's cohort for a past day is
// what they WERE on that day, not what they are now. R1/R2 are that assertion.
// The same contact, from the SAME single click, reconstructs as 'hot' for a day
// 90 days ago and 'warm' for yesterday — because the click was 10 days old then
// and 99 days old now. If the replay ever degrades into a lookup of the current
// status, both days return the same value and one of the two bars goes red.
//
// ⚠️ THE BARS RUN THE REAL SCRIPT, as a child process, with --org pointing at a
// throwaway org. Calling an extracted helper would test a copy of the replay;
// the artifact that will be run against production is this command line.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-reconstruction.ts

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__LIFECYCLE_RECONSTRUCTION_TEST__";

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
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `recon-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    const brand = await one<{ id: number }>(
      sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
    );
    const dom = await one<{ id: number }>(sql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${org}, ${brand.id}, ${`${tag}.example`}) RETURNING id`);
    const dest = await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${org}, 'https://example.com/x', ${`h-${tag}`}) RETURNING id`);
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id)
      VALUES (${org}, ${`rc-${tag}`}, ${`RC ${tag}`}, 'completed', 'manual', ${brand.id})
      RETURNING id`);
    const stage = await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
      VALUES (${org}, ${camp.id}, 1, 'STOP') RETURNING id`);

    const phones = fictionalPhones(3);
    await refuseIfPhonesInUse(db, phones);
    const mkContact = async (i: number) =>
      (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, line_type)
          VALUES (${org}, ${phones[i]}, 'mobile') RETURNING id`)
      ).id;

    const cA = await mkContact(0); // one click, 100 days ago
    const cB = await mkContact(1); // 12 messages, never clicked ⇒ freeze
    const cC = await mkContact(2); // 1 message, never clicked ⇒ cold

    const send = async (contactId: string, phone: string, daysAgo: number) =>
      (
        await one<{ id: string }>(sql`
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${org}, ${camp.id}, ${stage.id}, ${contactId}::uuid, ${phone},
                  'hi', 'sent', ${ago(daysAgo)}::timestamptz)
          RETURNING id`)
      ).id;

    // ── contact A: ONE human click, 100 days ago ────────────────────────────
    const link = await one<{ id: number }>(sql`
      INSERT INTO links (org_id, code, short_domain_id, destination_id,
                         campaign_id, stage_id, contact_id, send_token,
                             campaign_tracking_id, stage_tracking_id)
      VALUES (${org}, ${`c-${tag}`}, ${dom.id}, ${dest.id},
              ${camp.id}, ${stage.id}, ${cA}::uuid, ${`t-${tag}`},
              ${`ct-${tag}`}, ${`st-${tag}`}) RETURNING id`);
    await db.execute(sql`
      INSERT INTO clicks (org_id, link_id, clicked_at, classification, scored_at)
      VALUES (${org}, ${link.id}, ${ago(100)}::timestamptz, 'human', ${ago(100)}::timestamptz)`);

    // A is messaged on BOTH target days. Same click, two different ages.
    const sendA90 = await send(cA, phones[0], 90);
    const sendA1 = await send(cA, phones[0], 1);
    // B: 12 messages by yesterday, none clicked ⇒ msgs_since_click 12 ≥ 10.
    for (let d = 12; d >= 2; d--) await send(cB, phones[1], d);
    const sendB1 = await send(cB, phones[1], 1);
    const sendC1 = await send(cC, phones[2], 1);

    const etDay = async (daysAgo: number) =>
      (
        await one<{ d: string }>(sql`
          SELECT (${ago(daysAgo)}::timestamptz AT TIME ZONE 'America/New_York')::date::text AS d`)
      ).d;
    const D1 = await etDay(90);
    const D2 = await etDay(1);
    console.log(`  fixture days: D1 = ${D1} (90d ago), D2 = ${D2} (yesterday)\n`);

    // ── running the real script ──────────────────────────────────────────────
    const runBackfill = (args: string[]) => {
      // shell: true is required — Node will not spawn npx.cmd without one on
      // Windows (status null, nothing runs). It costs a deprecation notice about
      // unescaped arguments; every argument here is a literal or a UUID.
      const r = spawnSync(
        "npx",
        [
          "tsx", "--conditions=react-server",
          "scripts/backfill-lifecycle-reconstruction.ts",
          "--org", orgId, "--days", "150", ...args,
        ],
        { encoding: "utf-8", shell: true, env: process.env },
      );
      if (r.status !== 0) {
        console.error(r.stdout, r.stderr);
        throw new Error(`backfill exited ${r.status}`);
      }
      return r.stdout;
    };
    const statusOf = async (sendId: string) =>
      (
        await all<{ status: string; reconstructed: boolean }>(sql`
          SELECT status, reconstructed FROM stage_send_lifecycle
          WHERE stage_send_id = ${sendId}::uuid`)
      )[0] ?? null;

    console.log("PART R — day-N facts, not today's status");
    // ⚠️ DRY RUN FIRST, deliberately: if it wrote anything, R1's "hot" could
    // come from the dry run rather than from the apply under test.
    runBackfill([]);
    const afterDry = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM stage_send_lifecycle WHERE org_id = ${org}`);
    bar(
      "R0 the dry run writes nothing",
      Number(afterDry.n) === 0,
      `${afterDry.n} row(s)`,
    );

    runBackfill(["--day", D1, "--apply"]);
    const a90 = await statusOf(sendA90);
    bar(
      "R1 ⭐ 90 days ago the click was 10 days old ⇒ hot",
      a90?.status === "hot",
      `got ${a90?.status ?? "no row"}`,
    );

    const out2 = runBackfill(["--day", D2, "--apply"]);
    const a1 = await statusOf(sendA1);
    bar(
      "R2 ⭐ yesterday the SAME click was 99 days old ⇒ warm, not hot",
      a1?.status === "warm",
      `got ${a1?.status ?? "no row"}`,
    );
    bar(
      "R3 reconstructed = true on what it writes",
      a90?.reconstructed === true && a1?.reconstructed === true,
    );
    const bStatus = (await statusOf(sendB1))?.status;
    bar(
      "R4 12 messages, never clicked ⇒ freeze",
      bStatus === "freeze",
      `got ${bStatus ?? "no row"}`,
    );
    const cStatus = (await statusOf(sendC1))?.status;
    bar(
      "R5 1 message, never clicked ⇒ cold",
      cStatus === "cold",
      `got ${cStatus ?? "no row"}`,
    );

    console.log("\nPART S — what it must never write");
    const written = await all<{ status: string; n: number }>(sql`
      SELECT status, count(*)::int AS n FROM stage_send_lifecycle
      WHERE org_id = ${org} GROUP BY 1`);
    bar(
      "S1 no 'suppressed' row (spec §10 — it could not have happened)",
      !written.some((w) => w.status === "suppressed"),
      written.map((w) => `${w.status} ${w.n}`).join(" · "),
    );
    // Not a tautology: asOf is the END of the ET day, so the day's own send is
    // already counted. Moving asOf to the day's start would produce 'new' for a
    // contact's first-ever message, and a cohort nobody could act on.
    bar(
      "S2 no 'new' row — asOf is end-of-day, so the day's own send counts",
      !written.some((w) => w.status === "new"),
    );

    console.log("\nPART T — resume is derived from the data");
    const out3 = runBackfill(["--day", D2, "--apply"]);
    bar(
      "T1 a completed day is reported as already complete, not redone",
      /already complete 1/.test(out3),
      out3.match(/days processed \d+, already complete \d+/)?.[0] ?? "no summary",
    );
    bar("T2 …and it writes nothing the second time", /rows WRITTEN: 0/.test(out3));
    bar("T3 the first apply of that day DID write", /rows WRITTEN: [1-9]/.test(out2));

    const src = readFileSync(
      "scripts/backfill-lifecycle-reconstruction.ts",
      "utf-8",
    );
    bar(
      "T4 ⭐ resume reads the data, not a cursor file",
      /d\.unstamped === 0/.test(src) && !/readFileSync|writeFileSync/.test(src),
      "a cursor file lies after a partial failure",
    );
    bar(
      "T5 the suppressed→freeze coercion is in the INSERT, not only the report",
      /INSERT INTO stage_send_lifecycle[\s\S]{0,400}WHEN f\.status = 'suppressed' THEN 'freeze'/.test(
        src,
      ),
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
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_send_lifecycle WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM clicks WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)) AS n`);
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
