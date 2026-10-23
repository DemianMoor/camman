import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE STATUS-AT-SEND STAMP ON EVERY PATH THAT CREATES A SENDABLE ROW.
//
// ⭐ WHY THIS EXISTS. Until 2026-10-23 only kickoff stamped. The drip
// producers inserted stage_sends with no stamp, so every drip send landed in
// the Lifecycle report's Unclassified row — 233,240 sends in 09-23→10-22 —
// and nobody noticed for 17 days because the row looked like missing history.
//
// PART S is a source guard over the producers (a new producer that forgets the
// stamp fails here, not in a report weeks later). PART D runs the shared SQL
// against the preview DB inside a transaction that always rolls back.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-stamp.ts

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// Each INSERT INTO stage_sends, and the 1,200 characters after it — the span
// that holds the statement's RETURNING and the stamp CTE.
function insertSpans(src: string): string[] {
  const out: string[] = [];
  const re = /INSERT INTO stage_sends\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(src.slice(m.index, m.index + 1200));
  return out;
}

async function main() {
  console.log("PART S — every sendable producer stamps in the same statement");
  for (const file of ["lib/sends/kickoff.ts", "lib/drip/scheduler.ts", "lib/drip/send-one.ts"]) {
    const spans = insertSpans(readFileSync(file, "utf8"));
    bar(
      `S ${file}: every INSERT INTO stage_sends carries lifecycleStampInsertSql`,
      spans.length > 0 && spans.every((s) => s.includes("lifecycleStampInsertSql(sql`ins`)")),
      `${spans.length} insert(s)`,
    );
  }
  const skip = readFileSync("lib/drip/skip-send.ts", "utf8");
  bar(
    "S skip-send.ts writes skipped_ineligible rows and does NOT stamp them (never sent)",
    skip.includes("'skipped_ineligible'") && !skip.includes("lifecycleStampInsertSql"),
  );

  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { lifecycleStampInsertSql } = await import("@/lib/engagement/lifecycle-stamp");
  console.log(`\nTarget DB: ${requirePreviewDb().label}`);
  console.log("PART D — the shared stamp SQL (rolled back)");

  type Row = { status: string; last_click_at: string | null; reconstructed: boolean };
  let got: { warm?: Row; fresh?: Row; n?: number } = {};
  const clickAt = "2026-08-01T12:00:00.000Z";
  await db
    .transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];
      const sfx = Date.now().toString().slice(-8);
      const org = (
        await one<{ id: string }>(sql`
          INSERT INTO organizations (name) VALUES (${`__LC_STAMP_TEST__ ${sfx}`}) RETURNING id`)
      ).id;
      const camp = (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
          VALUES (${org}, ${`lcs-${sfx}`}, 'lcs', 'active', 'drip', 'tracked') RETURNING id`)
      ).id;
      const stage = (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)
      ).id;
      const mk = async (n: number) =>
        (
          await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${`+1903${sfx}${n}`})
            RETURNING id`)
        ).id;
      const warm = await mk(1);
      const fresh = await mk(2); // never evaluated: no contact_engagement row
      await tx.execute(sql`
        INSERT INTO contact_engagement (contact_id, org_id, status, status_changed_at, freeze_cadence_days, thresholds, last_click_at)
        VALUES (${warm}::uuid, ${org}::uuid, 'warm', now(), 14, '{}'::jsonb, ${clickAt}::timestamptz)`);

      // The producers' exact shape: a data-modifying CTE, then the stamp.
      const ins = (await tx.execute(sql`
        WITH ins AS (
          INSERT INTO stage_sends
            (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
          SELECT ${org}::uuid, ${camp}, ${stage}, c.id, c.phone_number, 'hi', 'pending'
          FROM contacts c WHERE c.id IN (${warm}::uuid, ${fresh}::uuid)
          RETURNING id, org_id, contact_id
        ), lc AS (${lifecycleStampInsertSql(sql`ins`)})
        SELECT id FROM ins`)) as unknown as { id: string }[];

      const stamps = (await tx.execute(sql`
        SELECT ss.contact_id::text AS contact_id, l.status,
               l.last_click_at::text AS last_click_at, l.reconstructed
        FROM stage_sends ss JOIN stage_send_lifecycle l ON l.stage_send_id = ss.id
        WHERE ss.stage_id = ${stage}`)) as unknown as (Row & { contact_id: string })[];
      got = {
        n: ins.length,
        warm: stamps.find((s) => s.contact_id === warm),
        fresh: stamps.find((s) => s.contact_id === fresh),
      };
      throw new Error("__ROLLBACK__");
    })
    .catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });

  bar("D1 one stamp per inserted send, in the same statement", got.n === 2 && !!got.warm && !!got.fresh);
  bar(
    "D2 ⭐ status AND last_click_at come from the contact's engagement row",
    got.warm?.status === "warm" &&
      got.warm?.last_click_at != null &&
      Date.parse(got.warm.last_click_at) === Date.parse(clickAt),
    JSON.stringify(got.warm),
  );
  bar(
    "D3 a contact the job has not evaluated is 'new' with no click time",
    got.fresh?.status === "new" && got.fresh?.last_click_at === null,
    JSON.stringify(got.fresh),
  );
  bar("D4 a live stamp is not marked reconstructed", got.warm?.reconstructed === false);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
