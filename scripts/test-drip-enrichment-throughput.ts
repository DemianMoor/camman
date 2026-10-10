import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { runEnrichmentBatch } from "@/lib/drip/enrichment";

// Drip enrichment: head-of-line + throughput (card 869ency4b items 2 and 6), PREVIEW DB.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-drip-enrichment-throughput.ts
//
//   E1 ⭐ lookup sub-cap spent: 300 older leads that still need Telnyx no longer
//      block 50 newer leads whose lookup already completed (cache hits)
//   E2 one tick keeps claiming batches until the inbox is drained (was ONE
//      batch of 200 per tick, and each cache miss costs two claims). Run with a
//      long deadline: from a client 24 ms from the DB every statement pays that
//      round trip, so wall time here is NOT production speed. Production runs in
//      fra1 next to eu-central-1; the per-tick figure is read from the cron log.
//
// Uses cache hits only (phone_lookups seeded 'complete'), so Telnyx is never
// called. Refuses to run unless lead_inbox is empty apart from its own rows —
// the worker claims across the whole inbox.

const MARKER = "__DRIP_ENRICH_THROUGHPUT_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const pending = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE status IN ('received','awaiting_lookup')`)).n;
  if (pending > 0) throw new Error(`REFUSING: lead_inbox already has ${pending} claimable row(s)`);

  const phones = fictionalPhones(850);
  await refuseIfPhonesInUse(db, phones);
  const needLookup = phones.slice(0, 300);
  const cachedE1 = phones.slice(300, 350);
  const burst = phones.slice(350);

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  let keyId = 0;
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    keyId = (await createPartnerWithKey(db, { orgId, slug: "et-" + sfx, name: "et", token: "toket" + sfx })).keyId;

    // Spend the org's drip lookup sub-cap for today.
    const cap = (await one<{ c: number }>(sql`SELECT drip_daily_cap AS c FROM lookup_settings LIMIT 1`)).c;
    await db.execute(sql`
      INSERT INTO lead_intake_daily (org_id, partner_key_id, day_et, interest_tag, lookups_spent)
      VALUES (${orgId}::uuid, ${keyId}, (now() AT TIME ZONE 'America/New_York')::date, 'et', ${cap})`);

    const seedLookups = async (list: string[]) => {
      for (const p of list) {
        await db.execute(sql`
          INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
          VALUES (${p}, 'mobile', 'manual_edit', 'complete', now())`);
      }
    };
    const seedInbox = async (list: string[], minAgo: number) => {
      for (const p of list) {
        await db.execute(sql`
          INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag)
          VALUES (${orgId}::uuid, ${keyId}, ${"et-" + sfx}, now() - make_interval(mins => ${minAgo}),
                  ${JSON.stringify({ phone: p })}::jsonb, ${p}, 'et')`);
      }
    };

    // ── E1 ──────────────────────────────────────────────────────────────
    await seedLookups(cachedE1);
    await seedInbox(needLookup, 10); // older, need Telnyx, budget spent
    await seedInbox(cachedE1, 5);    // newer, lookup already complete
    const e1 = await runEnrichmentBatch();
    const stillReceived = (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM lead_inbox WHERE org_id = ${orgId}::uuid AND status = 'received'`)).n;
    bar("E1 ⭐ sub-cap spent: the 50 ready leads are processed despite 300 older blocked ones",
      e1.processed === 50 && stillReceived === 300,
      `processed ${e1.processed}, capDeferred ${e1.capDeferred}, claimed ${e1.claimed}, still received ${stillReceived}`);
    bar("    the blocked leads are not claimed at all (no churn)", e1.capDeferred === 0, `capDeferred ${e1.capDeferred}`);

    // ── E2 ──────────────────────────────────────────────────────────────
    await seedLookups(burst);
    await seedInbox(burst, 1);
    const e2 = await runEnrichmentBatch(new Date(), { deadlineMs: 600_000 });
    const perMin = e2.elapsedMs > 0 ? Math.round((e2.processed / e2.elapsedMs) * 60_000) : 0;
    bar("E2 one tick processes the whole 500-lead burst across several batches",
      e2.processed === burst.length && e2.batches >= 3,
      `processed ${e2.processed} in ${e2.batches} batches, ${e2.elapsedMs} ms, ` +
      `${Math.round(e2.elapsedMs / Math.max(1, e2.processed))} ms/lead (≈${perMin}/min from this client; ` +
      `deadline hit ${e2.hitDeadline})`);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_inbox WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_daily WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_hourly WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const list = sql.join(phones.map((p) => sql`${p}`), sql`, `);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone IN (${list}) AND source = 'manual_edit'`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone IN (${list})`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM lead_inbox WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM phone_lookups WHERE phone IN (${list}))) AS n`);
    console.log(`\nTeardown: ${left.n} row(s) left`);
    if (Number(left.n) !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
